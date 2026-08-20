#!/bin/bash
# Installs a macOS Quick Action: right-click any image in Finder ->
# Quick Actions -> Luminesce. Output lands next to the original.
# Re-run after moving this repo; the repo path is baked in at install time.
set -euo pipefail

REPO="$(cd "$(dirname "$0")/.." && pwd)"
WF="$HOME/Library/Services/Luminesce.workflow"

mkdir -p "$WF/Contents"

cat > "$WF/Contents/Info.plist" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>NSServices</key>
  <array>
    <dict>
      <key>NSMenuItem</key>
      <dict><key>default</key><string>Luminesce</string></dict>
      <key>NSMessage</key>
      <string>runWorkflowAsService</string>
      <key>NSRequiredContext</key>
      <dict><key>NSApplicationIdentifier</key><string>com.apple.finder</string></dict>
      <key>NSSendFileTypes</key>
      <array><string>public.png</string><string>public.jpeg</string></array>
    </dict>
  </array>
</dict>
</plist>
PLIST

cat > "$WF/Contents/document.wflow" <<WFLOW
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>AMApplicationBuild</key><string>528</string>
  <key>AMApplicationVersion</key><string>2.10</string>
  <key>AMDocumentVersion</key><string>2</string>
  <key>actions</key>
  <array>
    <dict>
      <key>action</key>
      <dict>
        <key>AMAccepts</key>
        <dict>
          <key>Container</key><string>List</string>
          <key>Optional</key><true/>
          <key>Types</key><array><string>com.apple.cocoa.path</string></array>
        </dict>
        <key>AMActionVersion</key><string>2.0.3</string>
        <key>AMApplication</key><array><string>Automator</string></array>
        <key>AMParameterProperties</key>
        <dict>
          <key>COMMAND_STRING</key><dict/>
          <key>CheckedForUserDefaultShell</key><dict/>
          <key>inputMethod</key><dict/>
          <key>shell</key><dict/>
          <key>source</key><dict/>
        </dict>
        <key>AMProvides</key>
        <dict>
          <key>Container</key><string>List</string>
          <key>Types</key><array><string>com.apple.cocoa.string</string></array>
        </dict>
        <key>ActionBundlePath</key>
        <string>/System/Library/Automator/Run Shell Script.action</string>
        <key>ActionName</key><string>Run Shell Script</string>
        <key>ActionParameters</key>
        <dict>
          <key>COMMAND_STRING</key>
          <string>ok=0; fail=0
for f in "\$@"; do
  if /usr/bin/python3 "$REPO/luminescence.py" "\$f" >/dev/null 2>&amp;1; then
    ok=\$((ok+1))
  else
    fail=\$((fail+1))
  fi
done
msg="\$ok image(s) luminesced"
[ "\$fail" -gt 0 ] &amp;&amp; msg="\$msg, \$fail failed"
/usr/bin/osascript -e "display notification \\"\$msg\\" with title \\"Luminesce\\""</string>
          <key>CheckedForUserDefaultShell</key><true/>
          <key>inputMethod</key><integer>1</integer>
          <key>shell</key><string>/bin/bash</string>
          <key>source</key><string></string>
        </dict>
        <key>BundleIdentifier</key><string>com.apple.RunShellScript</string>
        <key>CFBundleVersion</key><string>2.0.3</string>
        <key>CanShowSelectedItemsWhenRun</key><false/>
        <key>CanShowWhenRun</key><true/>
        <key>Class Name</key><string>RunShellScriptAction</string>
        <key>InputUUID</key><string>3A2B4C5D-0001-4000-8000-LUMINESCE001</string>
        <key>Keywords</key><array><string>Shell</string></array>
        <key>OutputUUID</key><string>3A2B4C5D-0002-4000-8000-LUMINESCE002</string>
        <key>UUID</key><string>3A2B4C5D-0003-4000-8000-LUMINESCE003</string>
      </dict>
    </dict>
  </array>
  <key>connectors</key><dict/>
  <key>workflowMetaData</key>
  <dict>
    <key>serviceInputTypeIdentifier</key>
    <string>com.apple.Automator.fileSystemObject.image</string>
    <key>serviceProcessesInput</key><integer>0</integer>
    <key>workflowTypeIdentifier</key>
    <string>com.apple.Automator.servicesMenu</string>
  </dict>
</dict>
</plist>
WFLOW

plutil -lint "$WF/Contents/Info.plist" >/dev/null
plutil -lint "$WF/Contents/document.wflow" >/dev/null
echo "Installed: $WF"
echo "Right-click an image in Finder -> Quick Actions -> Luminesce"
