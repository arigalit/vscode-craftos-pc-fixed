const child_process = require('child_process');
const { SIGINT } = require('constants');
const fs = require('fs');
const https = require('https');
const os = require('os');
const path = require('path');
const process = require('process');
const semver = require('semver');
const URL = require('url').URL;
const vscode = require('vscode');
const vsls = require('vsls');
const WebSocket = require('ws');

var windows = {};
var crcTable = null;
var extcontext = null;
/** @type vscode.OutputChannel */
var log = {appendLine: () => {}};

function makeCRCTable() {
    let c;
    let crcTable = [];
    for (let n = 0; n < 256; n++) {
        c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        crcTable[n] = c;
    }
    return crcTable;
}

function crc32(str) {
    crcTable = crcTable || makeCRCTable();
    let crc = 0 ^ (-1);
    for (let i = 0; i < str.length; i++) {
        crc = (crc >>> 8) ^ crcTable[(crc ^ str.charCodeAt(i)) & 0xFF];
    }
    return (crc ^ (-1)) >>> 0;
};

function bufferstream(str) {
    let retval = {}
    retval.pos = 0
    retval.str = str
    retval.readUInt64 = function() {
        let r = Number(this.str.readBigUInt64LE(this.pos));
        this.pos += 8;
        return r;
    }
    retval.readUInt32 = function() {
        let r = this.str.readUInt32LE(this.pos);
        this.pos += 4;
        return r;
    }
    retval.readUInt16 = function() {
        let r = this.str.readUInt16LE(this.pos);
        this.pos += 2;
        return r;
    }
    retval.get = function() {
        return this.str.readUInt8(this.pos++);
    };
    retval.putback = function() {this.pos--;}
    // Reads a NUL-terminated UTF-8 string (throws if the terminator is missing)
    retval.readCString = function() {
        const end = this.str.indexOf(0, this.pos);
        if (end === -1) throw new RangeError("Unterminated string in packet");
        const r = this.str.toString("utf8", this.pos, end);
        this.pos = end + 1;
        return r;
    }
    return retval;
}

function validateURL(str) {
    try {
        let url = new URL(str);
        return url.protocol.toLowerCase() == "ws:" || url.protocol.toLowerCase() == "wss:";
    } catch (e) {return false;}
}

const computer_provider = {
    getChildren: element => {
        if ((element === undefined || element === null) && process_connection !== null) {
            let arr = [];
            for (let w in windows) if (!windows[w].isMonitor) arr.push({title: windows[w].term.title, id: w});
            return arr;
        } else return null;
    },
    getTreeItem: element => {
        let r = new vscode.TreeItem(element.title);
        r.iconPath = vscode.Uri.file(path.join(extcontext.extensionPath, 'media/computer.svg'));
        r.command = {command: "craftos-pc.open-window", title: "CraftOS-PC: Open Window", arguments: [element]};
        if (supportsFilesystem) r.contextValue = "data-available";
        return r;
    },
    _onDidChangeTreeData: new vscode.EventEmitter(),
};
computer_provider.onDidChangeTreeData = computer_provider._onDidChangeTreeData.event;

const monitor_provider = {
    getChildren: element => {
        if ((element === undefined || element === null) && process_connection !== null) {
            let arr = [];
            for (let w in windows) if (windows[w].isMonitor) arr.push({title: windows[w].term.title, id: w});
            return arr;
        }
        else return null;
    },
    getTreeItem: element => {
        let r = new vscode.TreeItem(element.title);
        r.iconPath = vscode.Uri.file(path.join(extcontext.extensionPath, 'media/monitor.svg'));
        r.command = {command: "craftos-pc.open-window", title: "CraftOS-PC: Open Window", arguments: [element]};
        return r;
    },
    _onDidChangeTreeData: new vscode.EventEmitter(),
}
monitor_provider.onDidChangeTreeData = monitor_provider._onDidChangeTreeData.event;

var process_connection = null;
var data_continuation = null;
var nextDataRequestID = 0;
var dataRequestCallbacks = {};
var isVersion11 = false;
var useBinaryChecksum = false;
var supportsFilesystem = false;
var gotMessage = false;
var didShowBetaMessage = false;
var processFeatures = {};
/** @type vsls.LiveShare|null */
var liveshare = null;
/** @type vsls.SharedServiceProxy|null */
var vslsClient = null;
/** @type vsls.SharedService|null */
var vslsServer = null;

function getSetting(name) {
    const config = vscode.workspace.getConfiguration(name);
    if (config.get("all") !== null && config.get("all") !== "") return config.get("all");
    else if (os.platform() === "win32") return config.get("windows").replace(/%([^%]+)%/g, (_, n) => process.env[n] || ('%' + n + '%'));
    else if (os.platform() === "darwin") return config.get("mac").replace(/\$(\w+)/g, (_, n) => process.env[n] || ('$' + n)).replace(/\${([^}]+)}/g, (_, n) => process.env[n] || ('${' + n + '}'));
    else if (os.platform() === "linux") return config.get("linux").replace(/\$(\w+)/g, (_, n) => process.env[n] || ('$' + n)).replace(/\${([^}]+)}/g, (_, n) => process.env[n] || ('${' + n + '}'));
    else return null;
}

function getDataPath() {
    const config = vscode.workspace.getConfiguration("craftos-pc");
    if (config.get("dataPath") !== null && config.get("dataPath") !== "") return config.get("dataPath");
    else if (os.platform() === "win32") return "%appdata%\\CraftOS-PC".replace(/%([^%]+)%/g, (_, n) => process.env[n] || ('%' + n + '%'));
    else if (os.platform() === "darwin") return "$HOME/Library/Application Support/CraftOS-PC".replace(/\$(\w+)/g, (_, n) => process.env[n] || ('$' + n)).replace(/\${([^}]+)}/g, (_, n) => process.env[n] || ('${' + n + '}'))
    else if (os.platform() === "linux") return "$HOME/.local/craftos-pc".replace(/\$(\w+)/g, (_, n) => process.env[n] || ('$' + n)).replace(/\${([^}]+)}/g, (_, n) => process.env[n] || ('${' + n + '}'))
    else return null;
}

function getExecutable() {
    let path = getSetting("craftos-pc.executablePath");
    if (path !== null && fs.existsSync(path)) return path;
    if (os.platform() === "win32") {
        path = "%localappdata%\\Programs\\CraftOS-PC\\CraftOS-PC_console.exe".replace(/%([^%]+)%/g, (_, n) => process.env[n] || ('%' + n + '%'));
        if (fs.existsSync(path)) return path;
    }
    if (path !== null && os.platform() === "win32" && fs.existsSync(path.replace("_console", ""))) {
        vscode.window.showErrorMessage("The CraftOS-PC installation is missing the console version, which is required for this extension to function. Please run the installer again, making sure to check the 'Console build for raw mode' box.");
        return null;
    }
    vscode.window.showErrorMessage("The CraftOS-PC executable could not be found. Check the path in the settings. If you haven't installed CraftOS-PC yet, [download it from the official website.](https://www.craftos-pc.cc)");
    return null;
}

function rejectPendingRequests(err) {
    const queued = dataRequestQueue;
    dataRequestQueue = [];
    for (const req of queued) req.reject(err);
    for (const id of Object.keys(dataRequestCallbacks)) {
        const cb = dataRequestCallbacks[id];
        try { cb(null, err); } catch (e) {}
    }
    dataRequestCallbacks = {};
    dataRequestInflight = 0;
}

function closeAllWindows() {
    rejectPendingRequests(vscode.FileSystemError.Unavailable("Computer connection closed"));
    data_continuation = null;
    supportsFilesystem = false;
    for (let k in windows) if (windows[k].panel !== undefined) windows[k].panel.dispose();
    windows = {};
    computer_provider._onDidChangeTreeData.fire(null);
    monitor_provider._onDidChangeTreeData.fire(null);
    if (vslsServer !== null) vslsServer.notify("windows", {});
}

const MAX_INFLIGHT_REQUESTS = 32;
var dataRequestQueue = [];
var dataRequestInflight = 0;

function allocRequestID() {
    // Request IDs are only 8 bits wide: never hand out one that is still waiting for an answer.
    for (let i = 0; i < 256; i++) {
        const id = nextDataRequestID;
        nextDataRequestID = (nextDataRequestID + 1) & 0xFF;
        if (!dataRequestCallbacks[id]) return id;
    }
    return -1;
}

function pumpDataRequests() {
    while (dataRequestInflight < MAX_INFLIGHT_REQUESTS && dataRequestQueue.length > 0) {
        const req = dataRequestQueue.shift();
        if (process_connection === null) {
            req.reject(vscode.FileSystemError.Unavailable("Computer connection not open yet"));
            continue;
        }
        sendDataRequest(req);
    }
}

function queueDataRequest(id, type, path, path2) {
    if (process_connection === null) return Promise.reject(vscode.FileSystemError.Unavailable("Computer connection not open yet"));
    return new Promise((resolve, reject) => {
        dataRequestQueue.push({id, type, path, path2, resolve, reject});
        pumpDataRequests();
    });
}

function sendDataRequest(req) {
    let {id, type, path, path2} = req;
    const reqid = allocRequestID();
    if (reqid < 0) {
        req.reject(vscode.FileSystemError.Unavailable("Too many pending requests"));
        return;
    }
    let filedata = undefined;
    if ((type & 0xF1) === 0x11) {
        filedata = path2;
        path2 = undefined;
    }
    const pathbuf = Buffer.from(path, "utf8");
    const path2buf = (typeof path2 === "string" ? Buffer.from(path2, "utf8") : null);
    const data = Buffer.alloc(5 + pathbuf.length + (path2buf !== null ? path2buf.length + 1 : 0));
    data[0] = 7;
    data[1] = id;
    data[2] = type;
    data[3] = reqid;
    pathbuf.copy(data, 4);
    if (path2buf !== null) path2buf.copy(data, 5 + pathbuf.length);
    const b64 = data.toString('base64');
    const packet = "!CPC" + ("000" + b64.length.toString(16)).slice(-4) + b64 + ("0000000" + crc32(useBinaryChecksum ? data.toString("binary") : b64).toString(16)).slice(-8) + "\n";

    let done = false;
    dataRequestInflight++;
    const timeoutMs = (type === 20 || type === 21) ? 30000 : 10000;
    const finish = () => {
        if (done) return false;
        done = true;
        clearTimeout(tid);
        delete dataRequestCallbacks[reqid];
        dataRequestInflight = Math.max(0, dataRequestInflight - 1);
        return true;
    };
    const tid = setTimeout(() => {
        if (!finish()) return;
        log.appendLine("Could not get info for " + path + " (request " + reqid + ")");
        req.reject(vscode.FileSystemError.Unavailable("Timed out waiting for CraftOS-PC to answer (" + path + ")"));
        pumpDataRequests();
    }, timeoutMs);
    dataRequestCallbacks[reqid] = (result, err) => {
        if (!finish()) return;
        if (!err) req.resolve(result);
        else req.reject(err);
        pumpDataRequests();
    };

    try {
        process_connection.stdin.write(packet, 'utf8');
        if (typeof filedata !== "undefined") {
            const filebuf = Buffer.isBuffer(filedata) ? filedata : Buffer.from(filedata);
            const data2 = Buffer.alloc(8 + filebuf.length);
            data2[0] = 9;
            data2[1] = id;
            data2[2] = 0;
            data2[3] = reqid;
            data2.writeInt32LE(filebuf.length, 4);
            filebuf.copy(data2, 8);
            const b642 = data2.toString('base64');
            const packet2 = (b642.length > 65535 ? "!CPD" + ("00000000000" + b642.length.toString(16)).slice(-12) : "!CPC" + ("000" + b642.length.toString(16)).slice(-4)) + b642 + ("0000000" + crc32(useBinaryChecksum ? data2.toString("binary") : b642).toString(16)).slice(-8) + "\n";
            process_connection.stdin.write(packet2, 'utf8');
        }
    } catch (e) {
        if (finish()) {
            req.reject(vscode.FileSystemError.Unavailable("Failed to send request: " + (e && e.message)));
            pumpDataRequests();
        }
    }
}

function checkVersion(silent) {
    const exe_path = getSetting("craftos-pc.executablePath");
    if (exe_path === null) return;
    child_process.execFile(exe_path, ["--version"], {windowsHide: true}, (err, stdout, stderr) => {
        if (err) {
            if (!silent) vscode.window.showErrorMessage("Failed to detect CraftOS-PC version (error: " + err.message + "). Please check that the path is correct and working properly.");
            return;
        }
        let version = (stdout.match(/CraftOS-PC v([\d\.]+)/) || [])[1];
        if (version === undefined || version === null) {
            if (!silent) vscode.window.showErrorMessage("Failed to detect CraftOS-PC version (error: no version number detected)." + (os.platform === "win32" ? "Make sure the path is pointing to CraftOS-PC_console.exe, and not CraftOS-PC.exe." : ""));
            return;
        }
        log.appendLine("Detected CraftOS-PC " + version);
        version = semver.coerce(version);
        processFeatures.debugger = semver.gt(version, "2.6.6");
        processFeatures.filesystem = semver.gte(version, "2.6.0");
        if (!silent) {
            if (version == "2.5.4" || version == "2.5.5") vscode.window.showWarningMessage("This version of CraftOS-PC crashes when using multiple windows. Update to a newer version to fix this.");
            else if (version == "2.5.1") vscode.window.showWarningMessage("This version of CraftOS-PC often crashes when using the extension. Update to a newer version to fix this.");
            else if (semver.lt(version, "2.4.0")) vscode.window.showWarningMessage("This version of CraftOS-PC does not support using multiple windows properly. Update to a newer version to fix this.");
        }
    });
}

/**
 * @implements {vscode.FileSystemProvider}
 */
class RawFileSystemProvider {
    constructor() {
        this._onDidChangeFile = new vscode.EventEmitter()
        this.onDidChangeFile = this._onDidChangeFile.event
    }
    _check() {
        if (process_connection === null) throw vscode.FileSystemError.Unavailable("Computer connection not open yet");
        if (!supportsFilesystem) throw vscode.FileSystemError.Unavailable("Connected computer doesn't support filesystems");
    }
    /** Turns protocol errors into proper FileSystemErrors so VS Code can show sensible messages. */
    _mapError(err, uri) {
        if (err instanceof vscode.FileSystemError) return err;
        const msg = (err && err.message) ? String(err.message) : String(err);
        if (/not exist|not found|no such|does not exist/i.test(msg)) return vscode.FileSystemError.FileNotFound(uri);
        if (/already exists|file exists/i.test(msg)) return vscode.FileSystemError.FileExists(uri);
        if (/read.?only|permission|access denied/i.test(msg)) return vscode.FileSystemError.NoPermissions(uri);
        return new vscode.FileSystemError(msg);
    }
    _request(uri, type, path, path2) {
        return queueDataRequest(parseInt(uri.authority), type, path, path2).catch(err => { throw this._mapError(err, uri); });
    }
    _fire(events) {
        try { this._onDidChangeFile.fire(events); } catch (e) { log.appendLine("Failed to fire file event: " + e); }
    }
    /**
     * @param {vscode.Uri} source
     * @param {vscode.Uri} destination
     * @param {{overwrite: boolean}} options
     */
    async copy(source, destination, options) {
        this._check();
        if (source.authority !== destination.authority) throw vscode.FileSystemError.Unavailable("Cannot move across computers");
        await this._request(source, 12, source.path, destination.path);
        this._fire([{type: vscode.FileChangeType.Created, uri: destination}]);
    }
    /**
     * @param {vscode.Uri} uri 
     */
    async createDirectory(uri) {
        this._check();
        await this._request(uri, 10, uri.path);
        this._fire([{type: vscode.FileChangeType.Created, uri: uri}]);
    }
    /**
     * @param {vscode.Uri} uri 
     * @param {{recursive: boolean}} options
     */
    async delete(uri, options) {
        // Warning: ignores options.recursive (always true)
        this._check();
        await this._request(uri, 11, uri.path);
        this._fire([{type: vscode.FileChangeType.Deleted, uri: uri}]);
    }
    /**
     * @param {vscode.Uri} uri 
     */
    async readDirectory(uri) {
        this._check();
        const files = await this._request(uri, 7, uri.path);
        const arr = await Promise.all(files.map(f =>
            queueDataRequest(parseInt(uri.authority), 1, path.posix.join(uri.path, f))
                .then(isDir => [f, isDir ? vscode.FileType.Directory : vscode.FileType.File])
                .catch(() => [f, vscode.FileType.Unknown])
        ));
        const rank = t => t === vscode.FileType.Directory ? 0 : 1;
        arr.sort((a, b) => rank(a[1]) - rank(b[1]) || a[0].localeCompare(b[0]));
        return arr;
    }
    /**
     * @param {vscode.Uri} uri 
     */
    async readFile(uri) {
        this._check();
        const data = await this._request(uri, 20, uri.path);
        return data ? Uint8Array.from(data) : new Uint8Array(0);
    }
    /**
     * @param {vscode.Uri} oldUri 
     * @param {vscode.Uri} newUri 
     * @param {{overwrite: boolean}} options 
     */
    async rename(oldUri, newUri, options) {
        // Warning: ignores overwrite (always false)
        this._check();
        if (oldUri.authority !== newUri.authority) throw vscode.FileSystemError.Unavailable("Cannot move across computers");
        await this._request(oldUri, 13, oldUri.path, newUri.path);
        this._fire([{type: vscode.FileChangeType.Deleted, uri: oldUri}, {type: vscode.FileChangeType.Created, uri: newUri}]);
    }
    /**
     * @param {vscode.Uri} uri 
     */
    async stat(uri) {
        this._check();
        const attributes = await this._request(uri, 8, uri.path);
        if (attributes === null || attributes === undefined) throw vscode.FileSystemError.FileNotFound(uri);
        const result = {
            ctime: attributes.created.getTime(),
            mtime: attributes.modified.getTime(),
            size: attributes.size,
            type: attributes.isDir ? vscode.FileType.Directory : vscode.FileType.File
        };
        if (attributes.isReadOnly && vscode.FilePermission) result.permissions = vscode.FilePermission.Readonly;
        return result;
    }
    /**
     * @param {vscode.Uri} uri 
     * @param {{excludes: string[], recursive: boolean}} options
     */
    watch(uri, options) {
        // Change notifications are not implemented, but VS Code expects a Disposable here.
        // This must never throw, even if the connection isn't open yet (workspace restore).
        return new vscode.Disposable(() => {});
    }
    /**
     * @param {vscode.Uri} uri 
     * @param {Uint8Array} content
     * @param {{create: boolean, overwrite: boolean}} options
     */
    async writeFile(uri, content, options) {
        this._check();
        let exists = true;
        if (!(options && options.create && options.overwrite)) {
            const attributes = await this._request(uri, 8, uri.path);
            exists = attributes !== null && attributes !== undefined;
            if (!exists && !options.create) throw vscode.FileSystemError.FileNotFound(uri);
            if (exists && options.create && !options.overwrite) throw vscode.FileSystemError.FileExists(uri);
        }
        await this._request(uri, 21, uri.path, Buffer.from(content));
        this._fire([{type: exists ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri: uri}]);
    }
}

const debugAdapterFactory = {
    /**
     * @param {vscode.DebugSession} session
     */
    createDebugAdapterDescriptor: (session, executable) => {
        if (session.configuration.request === "launch") {
            if (!processFeatures.debugger) {
                vscode.window.showErrorMessage("This version of CraftOS-PC does not support debugging. Please update to the latest version.");
                return null;
            }
            const exe_path = getSetting("craftos-pc.executablePath");
            if (exe_path === null) {
                vscode.window.showErrorMessage("Please set the path to the CraftOS-PC executable in the settings.");
                return null;
            }
            if (!fs.existsSync(exe_path)) {
                vscode.window.showErrorMessage("The CraftOS-PC executable could not be found. Check the path in the settings." + (os.platform() === "win32" ? " If you installed CraftOS-PC without administrator privileges, you will need to set the path manually. Also make sure CraftOS-PC_console.exe exists in the install directory - if not, reinstall CraftOS-PC with the Console build component enabled." : ""));
                return null;
            }
            const dir = vscode.workspace.getConfiguration("craftos-pc").get("dataPath");
            let args = splitArgs(vscode.workspace.getConfiguration("craftos-pc").get("additionalArguments"));
            args.push("--exec", "periphemu.create(0,'debug_adapter')");
            if (dir) args.splice(0, 0, "-d", dir);
            return new vscode.DebugAdapterExecutable(exe_path, args);
        } else if (session.configuration.request === "attach") {
            return new vscode.DebugAdapterServer(session.configuration.port || 12100, session.configuration.host);
        } else return undefined;
    }
}

/**
 * @param {Buffer} chunk data
 */
function processDataChunk(chunk) {
    if (typeof chunk === "string") chunk = Buffer.from(chunk, "utf8");
    else if (!Buffer.isBuffer(chunk)) chunk = Buffer.from(chunk);
    if (data_continuation !== null) {
        chunk = Buffer.concat([data_continuation, chunk]);
        data_continuation = null;
    }
    while (chunk.length > 0) {
        // skip whitespace between messages
        if (chunk[0] === 10 || chunk[0] === 13 || chunk[0] === 32 || chunk[0] === 9) {
            chunk = chunk.subarray(1);
            continue;
        }
        if (chunk.length < 4) {
            data_continuation = chunk;
            return;
        }
        const header = chunk.subarray(0, 4).toString();
        let off;
        if (header === "!CPC") off = 8;
        else if (header === "!CPD" && isVersion11) off = 16;
        else {
            // Not a packet: resynchronize on the next packet header instead of throwing everything away.
            log.appendLine("Invalid message, resynchronizing");
            const next = chunk.indexOf("!CP", 1);
            if (next === -1) return;
            chunk = chunk.subarray(next);
            continue;
        }
        if (chunk.length < off) {
            data_continuation = chunk;
            return;
        }
        const size = parseInt(chunk.subarray(4, off).toString(), 16);
        if (isNaN(size)) {
            log.appendLine("Invalid packet size, resynchronizing");
            chunk = chunk.subarray(4);
            continue;
        }
        const total = off + size + 8; // header + payload + checksum
        if (chunk.length < total) {
            // Incomplete packet: wait for the rest of it
            data_continuation = chunk;
            return;
        }
        const advance = () => { chunk = chunk.subarray(total); };
        try {
        const data = Buffer.from(chunk.subarray(off, size + off).toString(), 'base64');
        const good_checksum = parseInt(chunk.subarray(size + off, size + off + 8).toString(), 16);
        const data_checksum = crc32(useBinaryChecksum ? data.toString("binary") : chunk.subarray(off, size + off).toString());
        if (good_checksum !== data_checksum) {
            log.appendLine("Bad checksum: expected " + good_checksum.toString(16) + ", got " + data_checksum.toString(16));
            advance();
            continue;
        }
        let term = {}
        const stream = bufferstream(data);
        const type = stream.get();
        const id = stream.get();
        if (!gotMessage && type == 4 && process_connection) process_connection.stdin.write("!CPC0008BgADAA==498C93D2\n"); // 0x0003
        gotMessage = true;
        let winid = null;
        if (type === 0) {
            term.mode = stream.get();
            term.blink = stream.get() === 1;
            term.width = stream.readUInt16();
            term.height = stream.readUInt16();
            term.cursorX = stream.readUInt16();
            term.cursorY = stream.readUInt16();
            stream.readUInt32();
            term.screen = {}
            term.colors = {}
            term.pixels = {}
            if (term.mode === 0) {
                let c = stream.get();
                let n = stream.get();
                for (let y = 0; y < term.height; y++) {
                    term.screen[y] = {}
                    for (let x = 0; x < term.width; x++) {
                        term.screen[y][x] = c;
                        n--;
                        if (n === 0) {
                            c = stream.get();
                            n = stream.get();
                        }
                    }
                }
                for (let y = 0; y < term.height; y++) {
                    term.colors[y] = {}
                    for (let x = 0; x < term.width; x++) {
                        term.colors[y][x] = c;
                        n--;
                        if (n === 0) {
                            c = stream.get();
                            n = stream.get();
                        }
                    }
                }
                stream.putback();
                stream.putback();
            } else if (term.mode === 1 || term.mode === 2) {
                let c = stream.get();
                let n = stream.get();
                for (let y = 0; y < term.height * 9; y++) {
                    term.pixels[y] = {}
                    for (let x = 0; x < term.width * 6; x++) {
                        term.pixels[y][x] = c;
                        n--;
                        if (n === 0) {
                            c = stream.get();
                            n = stream.get();
                        }
                    }
                }
                stream.putback();
                stream.putback();
            }
            term.palette = {}
            if (term.mode === 0 || term.mode === 1) {
                for (let i = 0; i < 16; i++) {
                    term.palette[i] = {}
                    term.palette[i].r = stream.get();
                    term.palette[i].g = stream.get();
                    term.palette[i].b = stream.get();
                }
            } else if (term.mode === 2) {
                for (let i = 0; i < 256; i++) {
                    term.palette[i] = {}
                    term.palette[i].r = stream.get();
                    term.palette[i].g = stream.get();
                    term.palette[i].b = stream.get();
                }
            }
        } else if (type === 4) {
            const type2 = stream.get();
            if (type2 === 2) {
                if (process_connection.connected) {
                    process_connection.stdin.write("\n", "utf8");
                    process_connection.disconnect();
                } else {
                    process_connection.kill(SIGINT);
                    //vscode.window.showWarningMessage("The CraftOS-PC worker process did not close correctly. Some changes may not have been saved.")
                }
                closeAllWindows();
                return;
            } else if (type2 === 1) {
                if (windows[id] && windows[id].panel !== undefined) windows[id].panel.dispose();
                delete windows[id];
                computer_provider._onDidChangeTreeData.fire(null);
                monitor_provider._onDidChangeTreeData.fire(null);
                if (vslsServer !== null) vslsServer.notify("windows", windows);
                advance();
                continue;
            } else if (type2 === 0) {
                winid = stream.get();
                term.width = stream.readUInt16();
                term.height = stream.readUInt16();
                term.title = stream.readCString();
                if (windows[id] !== undefined) {
                    windows[id].isMonitor = typeof term.title === "string" && term.title.indexOf("Monitor") !== -1;
                    if (winid > 0) {
                        windows[id].computerID = winid - 1;
                        windows[id].isMonitor = false;
                    } else if (typeof term.title === "string" && term.title.match(/Computer \d+$/)) {
                        windows[id].computerID = parseInt(term.title.match(/Computer (\d+)$/)[1]);
                    }
                }
            }
        } else if (type === 5) {
            const flags = stream.readUInt32();
            let title = stream.readCString();
            let message = stream.readCString();
            switch (flags) {
                case 0x10: vscode.window.showErrorMessage("CraftOS-PC: " + title + ": " + message); break;
                case 0x20: vscode.window.showWarningMessage("CraftOS-PC: " + title + ": " + message); break;
                case 0x40: vscode.window.showInformationMessage("CraftOS-PC: " + title + ": " + message); break;
            }
        } else if (type === 6) {
            const flags = stream.readUInt16();
            isVersion11 = true;
            useBinaryChecksum = (flags & 1) === 1;
            supportsFilesystem = (flags & 2) === 2;
            computer_provider._onDidChangeTreeData.fire(null);
            if (vslsServer !== null) vslsServer.notify("flags", {isVersion11: isVersion11, useBinaryChecksum: useBinaryChecksum, supportsFilesystem: false});
        } else if (type === 8) {
            const reqtype = stream.get();
            const reqid = stream.get();
            if (!dataRequestCallbacks[reqid]) {
                log.appendLine("Got stray response for request ID " + reqid + ", ignoring.");
                advance();
                continue;
            }
            switch (reqtype) {
                case 0: case 1: case 2: {
                    const ok = stream.get();
                    if (ok === 0) dataRequestCallbacks[reqid](false);
                    else if (ok === 1) dataRequestCallbacks[reqid](true);
                    else dataRequestCallbacks[reqid](null, new Error("Operation failed"));
                    break;
                } case 3: case 5: case 6: {
                    const size = stream.readUInt32();
                    if (size === 0xFFFFFFFF) dataRequestCallbacks[reqid](null, new Error("Operation failed"));
                    else dataRequestCallbacks[reqid](size);
                    break;
                } case 4: {
                    let str = stream.readCString();
                    if (str !== "") dataRequestCallbacks[reqid](str);
                    else dataRequestCallbacks[reqid](null, new Error("Operation failed"));
                    break;
                } case 7: case 9: {
                    const size = stream.readUInt32();
                    if (size === 0xFFFFFFFF) dataRequestCallbacks[reqid](null, new Error("Operation failed"));
                    else {
                        let arr = [];
                        for (let i = 0; i < size; i++) {
                            arr[i] = stream.readCString();
                        }
                        dataRequestCallbacks[reqid](arr);
                    }
                    break;
                } case 8: {
                    let attr = {};
                    attr.size = stream.readUInt32();
                    attr.created = new Date(stream.readUInt64());
                    attr.modified = new Date(stream.readUInt64());
                    attr.isDir = stream.get() !== 0;
                    attr.isReadOnly = stream.get() !== 0;
                    const ok = stream.get();
                    if (ok === 0) dataRequestCallbacks[reqid](attr);
                    else if (ok === 1) dataRequestCallbacks[reqid](null);
                    else dataRequestCallbacks[reqid](null, new Error("Operation failed"));
                    break;
                } case 10: case 11: case 12: case 13:
                case 16: case 17: case 18: case 19:
                case 20: case 21: case 22: case 23: {
                    let str = stream.readCString();
                    if (str === "") dataRequestCallbacks[reqid]();
                    else dataRequestCallbacks[reqid](null, new Error(str));
                    break;
                }
            }
            delete dataRequestCallbacks[reqid];
        } else if (type === 9) {
            const fail = stream.get();
            const reqid = stream.get();
            if (!dataRequestCallbacks[reqid]) {
                log.appendLine("Got stray data response for request ID " + reqid + ", ignoring.");
                advance();
                continue;
            }
            const size = stream.readUInt32();
            const data = Buffer.alloc(size);
            stream.str.copy(data, 0, stream.pos);
            if (fail) dataRequestCallbacks[reqid](null, new Error(data.toString()));
            else dataRequestCallbacks[reqid](data);
            delete dataRequestCallbacks[reqid];
        }
        let newWindow = false;
        if (windows[id] === undefined) {windows[id] = {}; newWindow = true;}
        if (windows[id].term === undefined) windows[id].term = {};
        for (let k in term) windows[id].term[k] = term[k];
        if (windows[id].isMonitor === undefined) {
            windows[id].isMonitor = typeof windows[id].term.title === "string" && windows[id].term.title.indexOf("Monitor") !== -1;
            if (winid !== null && winid > 0) {
                windows[id].computerID = winid - 1;
                windows[id].isMonitor = false;
            } else if (typeof windows[id].term.title === "string" && windows[id].term.title.match(/Computer \d+$/)) {
                windows[id].computerID = parseInt(windows[id].term.title.match(/Computer (\d+)$/)[1]);
            }
        }
        if (windows[id].panel !== undefined) {
            windows[id].panel.webview.postMessage(windows[id].term);
            windows[id].panel.title = windows[id].term.title || "CraftOS-PC Terminal";
        }
        if (vslsServer !== null) {
            if (newWindow) vslsServer.notify("windows", windows);
            else vslsServer.notify("term", {id: id, term: windows[id].term, refresh: type === 4});
        }
        if (type === 4) {
            computer_provider._onDidChangeTreeData.fire(null);
            monitor_provider._onDidChangeTreeData.fire(null);
        }
        advance();
        } catch (e) {
            log.appendLine("Error while processing packet: " + (e && e.stack || e));
            advance();
        }
    }
}

const QUIT_PACKET = () => useBinaryChecksum ? "!CPC000CBAACAAAAAAAA2C7A548B\n" : "!CPC000CBAACAAAAAAAA3AB9B910\n";

function splitArgs(str) {
    return (typeof str === "string" ? str : "").split(/\s+/).filter(a => a.length > 0);
}

function resetConnectionState() {
    gotMessage = false;
    data_continuation = null;
    nextDataRequestID = 0;
    dataRequestCallbacks = {};
    dataRequestQueue = [];
    dataRequestInflight = 0;
    isVersion11 = false;
    useBinaryChecksum = false;
    supportsFilesystem = false;
}

/** Closes the current connection (if any) and forgets about it right away. */
function closeConnection() {
    const conn = process_connection;
    if (conn === null) return;
    process_connection = null; // detach first so late events from the old connection are ignored
    try {
        if (conn.connected) {
            conn.stdin.write(QUIT_PACKET(), "utf8");
            conn.disconnect();
        } else {
            try { conn.stdin.write(QUIT_PACKET(), "utf8"); } catch (e) {}
            conn.kill(SIGINT);
        }
    } catch (e) {
        log.appendLine("Error while closing connection: " + e);
    }
    closeAllWindows();
}

function connectToProcess(extra_args) {
    if (process_connection !== null) return true;
    const exe_path = getExecutable();
    if (exe_path === null) {
        return false;
    }
    const dir = vscode.workspace.getConfiguration("craftos-pc").get("dataPath");
    let process_options = {
        windowsHide: true
    };
    let args = splitArgs(vscode.workspace.getConfiguration("craftos-pc").get("additionalArguments"));
    args.push("--raw");
    if (dir) args.splice(-1, 0, "-d", dir);
    if (Array.isArray(extra_args)) args = args.concat(extra_args);
    log.appendLine("Running: " + exe_path + " " + args.join(" "));
    resetConnectionState();
    try {
        process_connection = child_process.spawn(exe_path, args, process_options);
    } catch (e) {
        vscode.window.showErrorMessage("The CraftOS-PC worker process could not be launched. Check the path to the executable in the settings.");
        log.appendLine(e);
        return;
    }
    // Events from a process we already replaced/closed must not tear down the new connection.
    const conn = process_connection;
    const isCurrent = () => process_connection === conn;
    conn.on("error", () => {
        if (!isCurrent()) return;
        vscode.window.showErrorMessage("The CraftOS-PC worker process could not be launched. Check the path to the executable in the settings.");
        process_connection = null;
        closeAllWindows();
    });
    conn.on("exit", code => {
        if (!isCurrent()) return;
        vscode.window.showInformationMessage(`The CraftOS-PC worker process exited with code ${code}.`)
        process_connection = null;
        closeAllWindows();
    });
    conn.on("disconnect", () => {
        if (!isCurrent()) return;
        vscode.window.showErrorMessage(`The CraftOS-PC worker process was disconnected from the window.`)
        process_connection = null;
        closeAllWindows();
    });
    conn.on("close", () => {
        if (!isCurrent()) return;
        //vscode.window.showInformationMessage(`The CraftOS-PC worker process closed all IO streams with code ${code}.`)
        process_connection = null;
        closeAllWindows();
    });
    conn.stdout.on("data", data => { if (isCurrent()) processDataChunk(data); });
    conn.stderr.on("data", data => {
        log.appendLine(data.toString());
    });
    conn.stdin.on("error", e => log.appendLine("stdin error: " + e));
    //process_connection.stdin.write("!CPC0008BgACAA==FBAC4FC2\n"); // 0x0002
    process_connection.stdin.write("!CPC0008BgADAA==498C93D2\n"); // 0x0003
    //process_connection.stdin.write("!CPC0008BgAGAA==0E2CE902\n"); // 0x0006
    //process_connection.stdin.write("!CPC0008BgAHAA==8C7C7ED3\n"); // 0x0007
    vscode.window.showInformationMessage("A new CraftOS-PC worker process has been started.");
    openPanel(0, true);
}

function connectToWebSocket(url) {
    if (process_connection !== null || url === undefined) return true;
    resetConnectionState();
    const socket = new WebSocket(url);
    // We insert a small shim here so we don't have to rewrite the other code.
    process_connection = {
        connected: socket.readyState == WebSocket.OPEN,
        disconnect: () => socket.close(),
        kill: () => socket.close(),
        stdin: {write: data => {
            if (socket.readyState !== WebSocket.OPEN) return;
            for (let i = 0; i < data.length; i += 65530) socket.send(data.substring(i, Math.min(i + 65530, data.length)));
        }}
    };
    const conn = process_connection;
    const isCurrent = () => process_connection === conn;
    socket.on("open", () => {
        //socket.send("!CPC0008BgACAA==FBAC4FC2\n"); // 0x0002
        //socket.send("!CPC0008BgADAA==498C93D2\n"); // 0x0003
        //socket.send("!CPC0008BgAGAA==0E2CE902\n"); // 0x0006
        socket.send("!CPC0008BgAHAA==8C7C7ED3\n"); // 0x0007
        vscode.window.showInformationMessage("Successfully connected to the WebSocket server.");
        if (!isCurrent()) return;
        process_connection.connected = true;
        openPanel(0, true);
    });
    socket.on("error", e => {
        if (!isCurrent()) return;
        if (e.message.match("certificate has expired"))
            vscode.window.showErrorMessage("A bug in VS Code is causing the connection to fail. Please go to https://www.craftos-pc.cc/docs/remote#certificate-has-expired-error to fix it.", "Open Page", "OK").then(res => {
                if (res === "OK") return;
                vscode.env.openExternal(vscode.Uri.parse("https://www.craftos-pc.cc/docs/remote#certificate-has-expired-error"));
            });
        else vscode.window.showErrorMessage("An error occurred while connecting to the server: " + e.message);
        process_connection = null;
        closeAllWindows();
    });
    socket.on("close", () => {
        if (!isCurrent()) return;
        vscode.window.showInformationMessage("Disconnected from the WebSocket server.");
        process_connection = null;
        closeAllWindows();
    });
    socket.on("message", data => { if (isCurrent()) processDataChunk(data); });
}

function openPanel(id, force) {
    if (!force && (extcontext === null || windows[id] === undefined)) return;
    if (windows[id] !== undefined && windows[id].panel !== undefined) {
        windows[id].panel.reveal();
        return;
    }
    const customFont = vscode.workspace.getConfiguration("craftos-pc.customFont");
    let fontPath = customFont.get("path");
    if (fontPath === "hdfont") {
        const execPath = getSetting("craftos-pc.executablePath");
        if (os.platform() === "win32") fontPath = execPath.replace(/[\/\\][^\/\\]+$/, "/") + "hdfont.bmp";
        else if (os.platform() === "darwin" && execPath.indexOf("MacOS/craftos") !== -1) fontPath = execPath.replace(/MacOS\/[^\/]+$/, "") + "Resources/hdfont.bmp";
        else if (os.platform() === "darwin" || (os.platform() === "linux" && !fs.existsSync("/usr/share/craftos/hdfont.bmp"))) fontPath = "/usr/local/share/craftos/hdfont.bmp";
        else if (os.platform() === "linux") fontPath = "/usr/share/craftos/hdfont.bmp";
        if (!fs.existsSync(fontPath)) {
            vscode.window.showWarningMessage("The path to the HD font could not be found; the default font will be used instead. Please set the path to the HD font manually.");
            fontPath = null;
        }
    }
    const panel = vscode.window.createWebviewPanel(
        'craftos-pc',
        'CraftOS-PC Terminal',
        vscode.window.activeTextEditor && vscode.window.activeTextEditor.viewColumn || vscode.ViewColumn.One,
        {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: (fontPath !== null && fontPath !== "") ? [vscode.Uri.file(fontPath.replace(/[\/\\][^\/\\]*$/, ""))] : null
        }
    );
    extcontext.subscriptions.push(panel);
    // Get path to resource on disk
    const onDiskPath = vscode.Uri.file(path.join(extcontext.extensionPath, 'index.html'));
    panel.iconPath = windows[id] && windows[id].isMonitor ? vscode.Uri.file(path.join(extcontext.extensionPath, 'media/monitor.svg')) : vscode.Uri.file(path.join(extcontext.extensionPath, 'media/computer.svg'));
    panel.webview.html = fs.readFileSync(onDiskPath.fsPath, 'utf8');
    panel.webview.onDidReceiveMessage(message => {
        if (typeof message !== "object" || process_connection === null) return;
        if (message.getFontPath === true) {
            if (fontPath !== null && fontPath !== "") panel.webview.postMessage({fontPath: panel.webview.asWebviewUri(vscode.Uri.file(fontPath)).toString()});
            return;
        }
        const data = Buffer.alloc(message.data.length / 2 + 2);
        data[0] = message.type;
        data[1] = id;
        Buffer.from(message.data, 'hex').copy(data, 2)
        const b64 = data.toString('base64');
        const packet = "!CPC" + ("000" + b64.length.toString(16)).slice(-4) + b64 + ("0000000" + crc32(useBinaryChecksum ? data.toString("binary") : b64).toString(16)).slice(-8) + "\n";
        process_connection.stdin.write(packet, 'utf8');
    });
    panel.onDidChangeViewState(e => {
        if (e.webviewPanel.active && windows[id].term !== undefined) {
            e.webviewPanel.webview.postMessage(windows[id].term);
            e.webviewPanel.title = windows[id].term.title || "CraftOS-PC Terminal";
        }
    });
    panel.onDidDispose(() => {if (windows[id].panel !== undefined) delete windows[id].panel;});
    let newWindow = false;
    if (windows[id] === undefined) {windows[id] = {}; newWindow = true;}
    windows[id].panel = panel;
    if (windows[id].term !== undefined) {
        windows[id].panel.webview.postMessage(windows[id].term);
        windows[id].panel.title = windows[id].term.title || "CraftOS-PC Terminal";
    }
    if (newWindow && vslsServer !== null) vslsServer.notify("windows", windows);
}

/**
 * @param {vscode.ExtensionContext} context
 */
/**
 * Adds the remote file system of a window as a workspace folder.
 * @returns {true|false|"exists"}
 */
function addRemoteFolder(id, title) {
    const clean = t => (typeof t === "string" ? t : "").replace(/^.*: */, "");
    const name = clean(title) || clean(windows[id] && windows[id].term && windows[id].term.title) || ("Computer " + id);
    const uri = vscode.Uri.parse(`craftos-pc://${id}/`);
    const folders = vscode.workspace.workspaceFolders || [];
    if (folders.some(f => f.uri.toString() === uri.toString())) return "exists";
    return vscode.workspace.updateWorkspaceFolders(folders.length, null, {name: name, uri: uri});
}

function activate(context) {

    log.appendLine("The CraftOS-PC extension is now active.");

    extcontext = context;

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open', () => {
        if (process_connection !== null) {
            vscode.window.showErrorMessage("Please close the current connection before using this command.");
            return;
        }
        return connectToProcess();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-websocket', obj => {
        if (process_connection !== null) {
            vscode.window.showErrorMessage("Please close the current connection before using this command.");
            return;
        }
        if (typeof obj === "string") return connectToWebSocket(obj);
        let wsHistory = context.globalState.get("JackMacWindows.craftos-pc/websocket-history", [""]);
        let quickPick = vscode.window.createQuickPick();
        quickPick.items = wsHistory.map(val => {return {label: val}});
        quickPick.title = "Enter the WebSocket URL:";
        quickPick.placeholder = "wss://";
        quickPick.canSelectMany = false;
        quickPick.onDidChangeValue(() => {
            wsHistory[0] = quickPick.value;
            quickPick.items = wsHistory.map(val => {return {label: val}});
        });
        quickPick.onDidAccept(() => {
            let str = quickPick.selectedItems[0].label;
            if (!validateURL(str)) vscode.window.showErrorMessage("The URL you entered is not valid.");
            else {
                wsHistory[0] = str;
                if (wsHistory.slice(1).includes(str))
                    wsHistory.splice(wsHistory.slice(1).indexOf(str)+1, 1);
                wsHistory.unshift("");
                context.globalState.update("JackMacWindows.craftos-pc/websocket-history", wsHistory);
                connectToWebSocket(str);
            }
        });
        quickPick.show();
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.clear-history', () => {
        context.globalState.update("JackMacWindows.craftos-pc/websocket-history", [""]);
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-new-remote', () => {
        if (process_connection !== null) {
            vscode.window.showErrorMessage("Please close the current connection before using this command.");
            return;
        }
        if (!didShowBetaMessage) {
            vscode.window.showWarningMessage("remote.craftos-pc.cc is currently in beta. Be aware that things may not work as expected. If you run into issues, please report them [on GitHub](https://github.com/MCJack123/remote.craftos-pc.cc/issues). If things break, use Shift+Ctrl+P (Shift+Cmd+P on Mac), then type 'reload window' and press Enter.");
            didShowBetaMessage = true;
        }
        https.get("https://remote.craftos-pc.cc/new", res => {
            if (Math.floor(res.statusCode / 100) !== 2) {
                vscode.window.showErrorMessage("Could not connect to remote.craftos-pc.cc: HTTP " + res.statusCode);
                res.resume();
                return;
            }
            res.setEncoding('utf8');
            let id = "";
            res.on('data', chunk => id += chunk);
            res.on('end', () => {
                vscode.env.clipboard.writeText("wget run https://remote.craftos-pc.cc/server.lua " + id);
                vscode.window.showInformationMessage("A command has been copied to the clipboard. Paste that into the ComputerCraft computer to establish the connection.");
                connectToWebSocket("wss://remote.craftos-pc.cc/" + id);
            });
        }).on('error', e => {
            if (e.message.match("certificate has expired"))
                vscode.window.showErrorMessage("A bug in VS Code is causing the connection to fail. Please go to https://www.craftos-pc.cc/docs/remote#certificate-has-expired-error to fix it.", "Open Page", "OK").then(res => {
                    if (res === "OK") return;
                    vscode.env.openExternal(vscode.Uri.parse("https://www.craftos-pc.cc/docs/remote#certificate-has-expired-error"));
                });
            else vscode.window.showErrorMessage("Could not connect to remote.craftos-pc.cc: " + e.message);
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-window', obj => {
        if (process_connection === null) {
            vscode.window.showErrorMessage("Please open CraftOS-PC before using this command.");
            return;
        }
        if (typeof obj === "object") openPanel(parseInt(obj.id));
        else vscode.window.showInputBox({prompt: "Enter the window ID:", validateInput: str => isNaN(parseInt(str)) ? "Invalid number" : null}).then(id => openPanel(parseInt(id)));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-config', () => {
        if (getDataPath() === null) {
            vscode.window.showErrorMessage("Please set the path to the CraftOS-PC data directory manually.");
            return;
        }
        vscode.commands.executeCommand("vscode.open", vscode.Uri.file(getDataPath() + "/config/global.json"));
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-computer-data', obj => {
        if (getDataPath() === null) {
            vscode.window.showErrorMessage("Please set the path to the CraftOS-PC data directory manually.");
            return;
        }
        if (typeof obj === "object") {
            vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(getDataPath() + "/computer/" + windows[parseInt(obj.id)].computerID), {forceNewWindow: true});
        } else {
            vscode.window.showInputBox({prompt: "Enter the computer ID:", validateInput: str => isNaN(parseInt(str)) ? "Invalid number" : null}).then(value => {
                if (!fs.existsSync(getDataPath() + "/computer/" + value)) vscode.window.showErrorMessage("The computer ID provided does not exist.");
                else vscode.commands.executeCommand("vscode.openFolder", vscode.Uri.file(getDataPath() + "/computer/" + value));
            });
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-remote-data', async obj => {
        if (process_connection === null) {
            vscode.window.showErrorMessage("Please open CraftOS-PC before using this command.");
            return;
        } else if (!supportsFilesystem) {
            vscode.window.showErrorMessage("This connection does not support file system access.");
            return;
        }
        let id, title;
        if (obj !== null && typeof obj === "object") {
            id = String(obj.id);
            title = obj.title;
        } else {
            const value = await vscode.window.showInputBox({prompt: "Enter the window ID:", validateInput: str => isNaN(parseInt(str)) ? "Invalid number" : null});
            if (value === undefined) return;
            id = String(parseInt(value));
            if (typeof windows[id] !== "object") {
                vscode.window.showErrorMessage("The window ID provided does not exist.");
                return;
            }
            title = windows[id].term && windows[id].term.title;
        }
        if (!vscode.workspace.workspaceFile) {
            // Adding a folder to a window without a workspace restarts the extension host, which closes the connection.
            const opt = await vscode.window.showWarningMessage("Due to technical limitations, opening the computer data will cause the connection to close. Please restart the connection after running this. Are you sure you want to continue?", "No", "Yes");
            if (opt !== "Yes") return; // "No" or dialog dismissed
            deactivate();
            addRemoteFolder(id, title);
        } else {
            const result = addRemoteFolder(id, title);
            if (result === "exists") vscode.window.showInformationMessage("The data of this computer is already in the workspace.");
            else if (result) vscode.window.showInformationMessage("A workspace is already open; the files have been added to the current workspace.");
            else vscode.window.showErrorMessage("Could not add the computer's files to the workspace.");
        }
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.open-primary-remote-data', obj => {
        vscode.commands.executeCommand("craftos-pc.open-remote-data", {title: "", id: 0})
    }));

    context.subscriptions.push(vscode.commands.registerCommand('craftos-pc.close', () => {
        if (process_connection === null) {
            vscode.window.showErrorMessage("Please open CraftOS-PC before using this command.");
            return;
        }
        process_connection.stdin.write(useBinaryChecksum ? "!CPC000CBAACAAAAAAAA2C7A548B\n" : "!CPC000CBAACAAAAAAAA3AB9B910\n", "utf8");
    }));

    context.subscriptions.push(vscode.commands.registerCommand("craftos-pc.close-window", obj => {
        if (process_connection === null) {
            vscode.window.showErrorMessage("Please open CraftOS-PC before using this command.");
            return;
        }
        let id;
        if (typeof obj === "object") id = new Promise(resolve => resolve(obj.id));
        else id = vscode.window.showInputBox({prompt: "Enter the window ID:", validateInput: str => isNaN(parseInt(str)) ? "Invalid number" : null});
        id.then(id => {
            const data = Buffer.alloc(9);
            data.fill(0);
            data[0] = 4;
            data[1] = parseInt(id);
            data[2] = 1;
            const b64 = data.toString("base64");
            process_connection.stdin.write("!CPC000C" + b64 + ("0000000" + crc32(useBinaryChecksum ? data.toString("binary") : b64).toString(16)).slice(-8) + "\n\n", "utf8");
        });
    }));

    context.subscriptions.push(vscode.commands.registerCommand("craftos-pc.kill", () => {
        if (process_connection === null) {
            vscode.window.showErrorMessage("Please open CraftOS-PC before using this command.");
            return;
        }
        closeConnection();
    }));

    context.subscriptions.push(vscode.commands.registerCommand("craftos-pc.run-file", async path => {
        if (!path) {
            if (vscode.window.activeTextEditor === undefined || vscode.window.activeTextEditor.document.uri.scheme !== "file") {
                vscode.window.showErrorMessage("Please open or save a file on disk before using this command.");
                return;
            }
            path = vscode.window.activeTextEditor.document.uri.fsPath;
        } else if (typeof path === "object" && path instanceof vscode.Uri) {
            if (path.scheme !== "file") {
                vscode.window.showErrorMessage("Please open or save a file on disk before using this command.");
                return;
            }
            path = path.fsPath;
        }
        if (process_connection !== null) {
            const mode = vscode.workspace.getConfiguration("craftos-pc").get("closeOldTerminalOnRun") || "ask";
            if (mode === "never") {
                vscode.window.showErrorMessage("Please close CraftOS-PC before using this command.");
                return;
            }
            if (mode === "ask") {
                const opt = await vscode.window.showWarningMessage("CraftOS-PC is already running. Close the old terminal and run this file?", "Close and Run");
                if (opt !== "Close and Run") return;
            }
            closeConnection();
        }
        return connectToProcess(["--script", path]);
    }));

    context.subscriptions.push(vscode.workspace.registerFileSystemProvider("craftos-pc", new RawFileSystemProvider()));
    context.subscriptions.push(vscode.window.registerUriHandler({handleUri: uri => {
        vscode.commands.executeCommand("craftos-pc.open-websocket", uri.path.replace(/^\//, ""));
    }}));

    context.subscriptions.push(vscode.debug.registerDebugAdapterDescriptorFactory("craftos-pc", debugAdapterFactory));
    
    log = vscode.window.createOutputChannel("CraftOS-PC");

    let change_timer = null;
    vscode.workspace.onDidChangeConfiguration(event => {
        if (event.affectsConfiguration("craftos-pc.executablePath")) {
            // Use a timer to debounce quick autosaves
            if (change_timer !== null) clearTimeout(change_timer);
            change_timer = setTimeout(() => {change_timer = null; checkVersion(false);}, 3000);
        }
    });

    vscode.window.createTreeView("craftos-computers", {"treeDataProvider": computer_provider});
    vscode.window.createTreeView("craftos-monitors", {"treeDataProvider": monitor_provider});

    vsls.getApi(context.extension.id).then(api => {
        if (api === null) return;
        liveshare = api;
        const updateSession = () => {
            if (liveshare.session.role === vsls.Role.Host && vslsServer === null) {
                if (vslsClient !== null && process_connection === null) {
                    windows = {};
                    computer_provider._onDidChangeTreeData.fire(null);
                    monitor_provider._onDidChangeTreeData.fire(null);
                    vslsClient = null;
                }
                liveshare.shareService("terminal").then(svc => {
                    vslsServer = svc;
                    vslsServer.onNotify("packet", data => {
                        // TODO: Add actual access control (MicrosoftDocs/live-share#1716)
                        const peer = liveshare.peers.find(a => a.peerNumber == data.peer);
                        if (process_connection !== null && (peer.access === vsls.Access.ReadWrite || peer.access === vsls.Access.Owner)) process_connection.stdin.write(data.data, "utf8");
                    });
                    vslsServer.onNotify("get-windows", () => {
                        vslsServer.notify("windows", windows);
                        vslsServer.notify("flags", {isVersion11: isVersion11, useBinaryChecksum: useBinaryChecksum, supportsFilesystem: false});
                    });
                }).catch(err => vscode.window.showErrorMessage("Could not create Live Share service: " + err));
            } else if (liveshare.session.role === vsls.Role.Guest && vslsClient === null) {
                vslsServer = null;
                liveshare.getSharedService("terminal").then(svc => {
                    vslsClient = svc;
                    vslsClient.onNotify("windows", param => {
                        let newwindows = {};
                        for (let id in param) newwindows[id] = {term: param[id].term, isMonitor: param[id].isMonitor, panel: windows[id] ? windows[id].panel : undefined};
                        for (let id in windows) if (!newwindows[id] && windows[id].panel) windows[id].panel.dispose();
                        windows = newwindows;
                        computer_provider._onDidChangeTreeData.fire(null);
                        monitor_provider._onDidChangeTreeData.fire(null);
                    });
                    vslsClient.onNotify("term", param => {
                        if (!windows[param.id]) return;
                        windows[param.id].term = param.term
                        if (windows[param.id].panel) {
                            windows[param.id].panel.webview.postMessage(param.term);
                            windows[param.id].panel.title = param.term.title || "CraftOS-PC Terminal";
                        }
                        if (param.refresh) {
                            computer_provider._onDidChangeTreeData.fire(null);
                            monitor_provider._onDidChangeTreeData.fire(null);
                        }
                    });
                    vslsClient.onNotify("flags", param => {
                        isVersion11 = param.isVersion11;
                        useBinaryChecksum = param.useBinaryChecksum;
                        supportsFilesystem = param.supportsFilesystem;
                    });
                    process_connection = {
                        connected: true,
                        disconnect: () => {},
                        kill: () => {},
                        stdin: {write: data => {
                            if (liveshare.session.access === vsls.Access.ReadWrite || liveshare.session.access === vsls.Access.Owner) vslsClient.notify("packet", {data: data, peer: liveshare.session.peerNumber});
                        }}
                    };
                    vslsClient.notify("get-windows", {});
                }).catch(err => vscode.window.showErrorMessage("Could not connect to Live Share service: " + err));
            } else if (liveshare.session.role === vsls.Role.None) {
                if (vslsClient !== null && process_connection !== null && process_connection.isLiveShare) {
                    windows = {};
                    computer_provider._onDidChangeTreeData.fire(null);
                    monitor_provider._onDidChangeTreeData.fire(null);
                    vslsClient = null;
                    process_connection = null;
                }
                vslsServer = null;
            }
        };
        liveshare.onDidChangeSession(updateSession);
        liveshare.onDidChangePeers(() => {
            if (vslsServer !== null) vslsServer.notify("windows", windows);
        });
        if (liveshare.session.role !== vsls.Role.None) updateSession();
    });

    checkVersion(true);
}
exports.activate = activate;

// this method is called when your extension is deactivated
function deactivate() {
    if (process_connection) {
        if (process_connection.connected) {
            process_connection.stdin.write(useBinaryChecksum ? "!CPC000CBAACAAAAAAAA2C7A548B\n" : "!CPC000CBAACAAAAAAAA3AB9B910\n", "utf8");
            process_connection.disconnect();
            if (process_connection.isWS) process_connection = null;
        } else {
            process_connection.kill(SIGINT);
            if (process_connection.isWS) process_connection = null;
        }
    }
    closeAllWindows();
}

module.exports = {
    activate,
    deactivate
}
