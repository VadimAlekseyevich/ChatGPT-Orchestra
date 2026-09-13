# Phase 16 — Native Messaging Host Registration

The companion bridge uses Chrome/Edge Native Messaging only as a narrow transport into the authenticated desktop loopback server. The registered native host is the packaged ChatGPT Orchestra desktop executable itself; no `.cmd`, shell interpolation or unauthenticated localhost control endpoint is introduced.

## Packaged desktop registration

Find the exact extension id in the browser extension manager, then run the installed Orchestra executable from a terminal.

Windows / Edge example:

```text
"C:\Program Files\ChatGPT Orchestra\ChatGPT Orchestra.exe" --register-native-host=<extension-id> --native-host-browsers=edge
```

Register for Edge and Chrome:

```text
ChatGPT Orchestra.exe --register-native-host=<extension-id> --native-host-browsers=edge,chrome
```

Unregister:

```text
ChatGPT Orchestra.exe --unregister-native-host --native-host-browsers=edge,chrome
```

The packaged executable recognizes the `chrome-extension://<id>/` argument supplied by Chromium browsers when they launch a Native Messaging host. In that mode it does not initialize the Electron GUI; it runs the stdio relay from `apps/companion/native-host.js`.

## Source/development registration

For repository development, registration can also be driven explicitly:

```bash
node scripts/register-native-host.js register \
  --extension-id=<extension-id> \
  --host-path=<absolute-path-to-stable-packaged-executable> \
  --browsers=edge
```

or through the package script:

```bash
npm run companion:register-host -- \
  --extension-id=<extension-id> \
  --host-path=<absolute-path-to-stable-packaged-executable> \
  --browsers=edge
```

Unregister:

```bash
npm run companion:unregister-host -- --browsers=edge
```

Do not register `node`, a `.js` file or a `.cmd` wrapper as the production Windows host. The manifest must point at a stable packaged Orchestra executable.

## Registration locations

Windows uses per-user registry keys and one generated manifest under Orchestra app-data:

```text
HKCU\Software\Microsoft\Edge\NativeMessagingHosts\com.chatgptorchestra.companion
HKCU\Software\Google\Chrome\NativeMessagingHosts\com.chatgptorchestra.companion
HKCU\Software\Chromium\NativeMessagingHosts\com.chatgptorchestra.companion
```

The default registry value is the absolute path to:

```text
<OrchestraData>/companion/native-host-manifest.json
```

Linux/macOS write the same manifest content into the browser-specific `NativeMessagingHosts` directory for each requested browser.

## Security properties

- extension ids must match the Chromium 32-character `a`–`p` id format;
- the host executable path must exist and be a regular file;
- Windows registration invokes `reg.exe` with an argv array, not a shell command string;
- generated manifests contain only the exact allowed extension origin;
- the native host still authenticates to the desktop loopback endpoint with the local pairing secret before forwarding any Orchestra RPC;
- GUI, migration and native relay use the same Orchestra data-directory resolver, so endpoint and pairing-secret paths cannot silently diverge by platform.

## Packaging note

A registration path is only stable when the desktop executable has a stable installed location. Directory builds are suitable for development; future distribution formats must preserve a stable executable path for Native Messaging registration. In particular, an ephemeral mounted executable path must not be persisted as the native host path.
