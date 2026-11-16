#!/bin/sh
# Adds the example's three platform folders and the two settings a loopback page needs. Run from the example folder.
set -e
flutter create --platforms=android,ios,macos --org app.rapier --project-name rapier_jxl_example .
rm -f test/widget_test.dart
python3 - <<'PY'
import re, pathlib
# iOS: the package's plug-in needs iOS 15.1. The project says so; a Podfile, where one exists yet, agrees (without one,
# CocoaPods takes the project's target). In Python, so the same lines run on macOS and Linux.
for path, find, put in (('ios/Runner.xcodeproj/project.pbxproj', r'IPHONEOS_DEPLOYMENT_TARGET = [0-9.]*;', 'IPHONEOS_DEPLOYMENT_TARGET = 15.1;'),
                        ('ios/Podfile', r'^(# *)?platform :ios, .*$', "platform :ios, '15.1'")):
    f = pathlib.Path(path)
    if f.exists(): f.write_text(re.sub(find, put, f.read_text(), flags=re.M))
# Android: the app serves its page on 127.0.0.1, so it needs the INTERNET permission and cleartext to that address only.
m = pathlib.Path('android/app/src/main/AndroidManifest.xml'); s = m.read_text()
s = s.replace('<application', '<uses-permission android:name="android.permission.INTERNET"/>\n    <application', 1)
s = s.replace('<application', '<application android:networkSecurityConfig="@xml/network_security_config"', 1)
m.write_text(s)
x = pathlib.Path('android/app/src/main/res/xml'); x.mkdir(parents=True, exist_ok=True)
(x / 'network_security_config.xml').write_text('<?xml version="1.0" encoding="utf-8"?>\n<network-security-config>\n    <domain-config cleartextTrafficPermitted="true"><domain includeSubdomains="false">127.0.0.1</domain></domain-config>\n</network-security-config>\n')
# iOS: loopback HTTP is allowed by ATS's local-networking key.
p = pathlib.Path('ios/Runner/Info.plist'); s = p.read_text()
s = s.replace('</dict>\n</plist>', '\t<key>NSAppTransportSecurity</key>\n\t<dict><key>NSAllowsLocalNetworking</key><true/></dict>\n</dict>\n</plist>')
p.write_text(s)
# macOS: the sandbox needs to open and use a socket.
for f in ('DebugProfile', 'Release'):
    p = pathlib.Path(f'macos/Runner/{f}.entitlements'); s = p.read_text()
    for key in ('network.server', 'network.client'):
        if f'com.apple.security.{key}' not in s:
            s = s.replace('</dict>', f'\t<key>com.apple.security.{key}</key>\n\t<true/>\n</dict>')
    p.write_text(s)
PY
