# Windows native support

The Windows target is Windows 10/11 x64. It runs Electron, the bundled Node/T3 engine, and ConPTY on Windows. WSL is not required. ARM64 packaging is not configured.

## Install and run

The `Windows native` CI workflow produces the `StrataMD-windows-x64` artifact containing an NSIS installer. Install it for the current user. The installer offers a destination folder, Start menu entry, desktop shortcut, and Markdown file associations. Choose StrataMD in Windows Default apps to make it the default Markdown editor.

The installed folder contains `StrataMD.exe` and `stratamd.cmd`. The command launcher works in Command Prompt and PowerShell. Run `stratamd.cmd setup` to create a managed launcher under `%LOCALAPPDATA%\stratamd\bin`, then add that directory to your user Path using Windows Environment Variables. Open a new terminal after changing Path. `setup --remove` removes that managed launcher. It doesn't uninstall the application or remove documents.

The app uses native window controls. Ctrl shortcuts match the Linux shortcuts. Start at login uses Electron's Windows login registration. Window capture refreshes the selected window at full resolution; Windows accessibility text is currently unavailable.

## Build from source

Install Node 24, pnpm 11, Python 3, and Visual Studio 2022 Build Tools with Desktop development with C++. Use an x64 terminal and a short checkout path. Run these commands in a fresh checkout:

```powershell
pnpm install --frozen-lockfile
node node_modules/electron/install.js
node node_modules/node-gyp/bin/node-gyp.js rebuild --directory native/unix-support
node scripts/build-packaged.mjs
```

The build prepares the checksum-pinned Windows Node distribution, builds node-pty for that Node version, verifies the runtime, and packages the installer. No signing certificate is configured, so Windows may show an unknown-publisher prompt.

## Verification and limits

The Windows workflow checks platform contracts, native storage and process ownership, the document acceptance scenarios, managed T3 integration, and the installed command launcher. It retains reports and failed Electron traces. The full existing Linux/macOS test suite is not yet portable to Windows; the Windows workflow uses the explicit selection above.

Native Windows execution must pass before this target is considered release-ready. Linux tests establish regression coverage, not Windows compatibility. The Windows parent IPC channel asks the stock server to shut down through its existing handlers. If an adopted engine has no parent channel or shutdown stalls, forced termination preserves recovery data; directory fsync and POSIX mode bits have no Windows equivalent in Node's filesystem API. User data inherits the user profile's Windows ACLs. Config is roaming AppData; engine and document state are local AppData. Explicit XDG overrides preserve test isolation.
