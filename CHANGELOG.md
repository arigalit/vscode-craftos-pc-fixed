# Change Log

All notable changes to the "craftos-pc" extension will be documented in this file.

## 1.2.4 (Fixed fork)

First release of the maintained fork.

### Remote file access
* Fixed packets being dropped when a response arrived in several pieces (main cause of files working only "sometimes")
* Fixed request IDs colliding in large folders; requests are now limited to 32 at a time and timeouts are longer
* Fixed folder listing hanging forever when a request failed
* Fixed saving files from VS Code failing
* Fixed the file watcher returning an invalid value, which could break opening/closing the remote folder
* The file explorer now refreshes after files are created, deleted, renamed or saved
* File names with non-ASCII characters (e.g. Cyrillic) now work correctly (UTF-8)
* Fixed paths using backslashes on Windows
* Errors are now reported as proper file system errors (e.g. "file not found")
* Pending requests are cancelled immediately when the connection closes
* Events from an old CraftOS-PC process no longer close a newly started connection
* Garbage data in the stream no longer breaks the connection; the parser resynchronizes

### Workspace / commands
* Closing the "connection will close" dialog no longer counts as "Yes"
* Opening remote data from the Command Palette now closes the connection cleanly
* Adding the same computer twice no longer shows a false "files added" message
* Fixed an empty folder name for the primary computer
* Added setting `craftos-pc.closeOldTerminalOnRun` (`ask` / `always` / `never`) for running a script while a terminal is already open
* Fixed `undefined` being passed to CraftOS-PC when starting a session, and `-d ""` being passed when `dataPath` is empty
* "Force Close Connection" now also cleans up the open windows

### Terminal
* Fixed mouse click positions on terminals that are not 51x19
* Fixed multi-line paste leaving extra lines
* Fixed a crash when a window that no longer exists was closed (possible cause of disconnects on PC reboot)
* Fixed a Live Share crash on updates for unknown windows

### Known limitations
* Scroll direction is reported as 0 instead of -1 when scrolling up; this is a CraftOS-PC bug, not an extension one
* Breakpoints may show as "unverified" until the debug adapter has started; this is handled by CraftOS-PC itself

## 1.2.3

* Added a new very prominent button to open files
* Added an extra alert when the files are already open

## 1.2.2

* Fixed an issue preventing uploading files between 48-64 kB in size

## 1.2.1

* Added automatic detection of user installations on Windows
* Adjusted some error messages to be more descriptive
* Added a new output channel for debugging messages

## 1.2.0

* Added debugger support for CraftOS-PC v2.7 and later
* Added support for Visual Studio Live Share
  * This currently requires manually allowing the extension to communicate

## 1.1.8

* Fixed a bug causing disconnections when sending large data packets

## 1.1.6

* Added Run Script button to quickly run files in a new CraftOS-PC instance

## 1.1.5

* Added history to Open WebSocket button

## 1.1.4

* Terminal windows now automatically resize to fit the screen
* Fixed an issue causing the bug info prompt from 1.1.3 to not appear

## 1.1.3

* Added more information about VS Code "certificate has expired" bug
* Added a "CraftOS-PC: Force Close Connection" to close the connection immediately without waiting for a response
* Fixed an issue causing remote screens to go black

## 1.1.1

* Fixed mouse_up event not being sent

## 1.1.0

* Added ability to connect to WebSocket servers
* Added integration with new remote.craftos-pc.cc service (beta)
* Added support for raw mode 1.1 specification
* Added URI handler for WebSocket links
* Fixed security vulnerability in glob-parent dependency

## 1.0.2

* Fixed wrong mouse buttons being sent
* Fixed drag coordinates in the margins of the screen
* Fixed mouse drag events firing in the same cell after click

## 1.0.1

* Fixed mouse events not being sent to the window

## 1.0.0

* Added support for custom fonts
  * Font files must be in the exact same format as ComputerCraft fonts (with the same outer padding area)
* Added close buttons to each window, as well as a global quit button
* Added buttons to open a new window with the selected computer's data directory
  * This requires either CraftOS-PC v2.5.6 or later, or computers labeled "Computer &gt;id&lt;"
* Added button to open the configuration
* Added paste event detection
* Added icons for monitors
* Updated extension icon to CraftOS-PC v2.4's new icon
* Fixed duplicate drag events being sent for the same character cell
* Fixed mouse events sending the wrong coordinates
* Fixed the computer background not being drawn properly
* Upgraded y18n and lodash to fix vulnerabilities (#3, #4)
* Reformatted code to be a bit more clean

## 0.2.1

* Added an error message if the executable is missing
* Fixed `mouse_click` events being sent instead of `mouse_drag`

## 0.2.0

* Fixed performance issues causing high CPU usage and major slowdown
  * Render speed should now be about the same as in standard GUI mode
* Added `craftos-pc.additionalArguments` setting
* Added command to close the emulator session without having to close each window
* Fixed a bug causing CraftOS-PC to not start on Windows when a workspace is open

## 0.1.1

Fixes a bug where the wrong key events were being sent (e.g. `key_up` when pressing a key down). Also fixes `char` events being sent with modifier keys held.

Download the latest build of CraftOS-PC (from 7/27/20 or later) to fix a bug with events being sent to the wrong window, as well as a bug preventing Ctrl-R/S/T from working properly.

## 0.1.0

First public alpha release.