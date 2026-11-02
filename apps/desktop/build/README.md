# Desktop icons

These are the stock Electron icons, copied without modification from Electron
v38.8.6, the runtime version in the npm lockfile:

- `icon.ico`: [Windows application icon](https://github.com/electron/electron/blob/v38.8.6/shell/browser/resources/win/electron.ico).
- `icon.png`: [Default application icon](https://github.com/electron/electron/blob/v38.8.6/default_app/icon.png).

Electron distributes these assets under its
[MIT license](https://github.com/electron/electron/blob/v38.8.6/LICENSE).

The builder configuration uses the ICO for the Windows executable, installer,
uninstaller, and installer header, and the PNG for Linux. The previous Tauri
assets have been replaced; the unused macOS icon has been removed.
