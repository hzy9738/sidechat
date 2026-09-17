#define AppName "安能助手"
#ifndef AppVersion
  #define AppVersion "0.6.3"
#endif
#ifndef HostBinary
  #define HostBinary "..\..\host-rs\target\x86_64-pc-windows-msvc\release\sidechat-host.exe"
#endif
#ifndef HostConfig
  #define HostConfig "..\..\.secrets\host-config.json"
#endif
#ifndef ExtensionId
  #define ExtensionId "hkifhagmdbdpaihdmllddcingebfpjmm"
#endif
#ifndef ExtensionUpdateUrl
  #define ExtensionUpdateUrl "https://clients2.google.com/service/update2/crx"
#endif

[Setup]
AppId={{35E634CB-4AC6-4B41-8D0A-78C528E1F4A4}
AppName={#AppName}
AppVersion={#AppVersion}
AppPublisher=正泰安能
DefaultDirName={autopf}\Anneng Assistant
DisableProgramGroupPage=yes
PrivilegesRequired=admin
ArchitecturesAllowed=x64compatible
ArchitecturesInstallIn64BitMode=x64compatible
OutputBaseFilename=Anneng-Assistant-{#AppVersion}-Windows
Compression=lzma2
SolidCompression=yes
WizardStyle=modern
WizardSizePercent=110
DisableWelcomePage=no
UninstallDisplayName={#AppName}

[Languages]
Name: "chinesesimp"; MessagesFile: "compiler:Languages\ChineseSimplified.isl"

[Files]
Source: "{#HostBinary}"; DestDir: "{app}"; DestName: "anneng-assistant-host.exe"; Flags: ignoreversion
Source: "{#HostConfig}"; DestDir: "{app}"; DestName: "anneng-config.json"; Flags: ignoreversion skipifsourcedoesntexist

[Tasks]
Name: "chrome"; Description: "Google Chrome"; GroupDescription: "安装到已检测到的浏览器："; Check: ChromeInstalled; Flags: checkedonce
Name: "edge"; Description: "Microsoft Edge"; GroupDescription: "安装到已检测到的浏览器："; Check: EdgeInstalled; Flags: checkedonce
Name: "brave"; Description: "Brave"; GroupDescription: "安装到已检测到的浏览器："; Check: BraveInstalled; Flags: checkedonce
Name: "360safe"; Description: "360 安全浏览器（兼容模式）"; GroupDescription: "安装到已检测到的浏览器："; Check: Browser360SafeInstalled; Flags: checkedonce
Name: "360speed"; Description: "360 极速浏览器（兼容模式）"; GroupDescription: "安装到已检测到的浏览器："; Check: Browser360SpeedInstalled; Flags: checkedonce
Name: "qqbrowser"; Description: "QQ 浏览器（兼容模式）"; GroupDescription: "安装到已检测到的浏览器："; Check: QQBrowserInstalled; Flags: checkedonce

[Registry]
; Chrome: force-install extension and register native host.
Root: HKLM64; Subkey: "Software\Policies\Google\Chrome\ExtensionInstallForcelist"; ValueType: string; ValueName: "{code:ChromePolicyValueName}"; ValueData: "{#ExtensionId};{#ExtensionUpdateUrl}"; Tasks: chrome; Flags: uninsdeletevalue
Root: HKLM64; Subkey: "Software\Google\Chrome\NativeMessagingHosts\com.hzy9738.sidechat"; ValueType: string; ValueName: ""; ValueData: "{app}\native-host.json"; Tasks: chrome; Flags: uninsdeletekey

; Edge can force-install the same Chromium extension from the configured update service.
Root: HKLM64; Subkey: "Software\Policies\Microsoft\Edge\ExtensionInstallForcelist"; ValueType: string; ValueName: "{code:EdgePolicyValueName}"; ValueData: "{#ExtensionId};{#ExtensionUpdateUrl}"; Tasks: edge; Flags: uninsdeletevalue
Root: HKLM64; Subkey: "Software\Microsoft\Edge\NativeMessagingHosts\com.hzy9738.sidechat"; ValueType: string; ValueName: ""; ValueData: "{app}\native-host.json"; Tasks: edge; Flags: uninsdeletekey

; Brave policy/native-host locations.
Root: HKLM64; Subkey: "Software\Policies\BraveSoftware\Brave\ExtensionInstallForcelist"; ValueType: string; ValueName: "{code:BravePolicyValueName}"; ValueData: "{#ExtensionId};{#ExtensionUpdateUrl}"; Tasks: brave; Flags: uninsdeletevalue
Root: HKLM64; Subkey: "Software\BraveSoftware\Brave-Browser\NativeMessagingHosts\com.hzy9738.sidechat"; ValueType: string; ValueName: ""; ValueData: "{app}\native-host.json"; Tasks: brave; Flags: uninsdeletekey

; 360/QQ consumer editions don't publish stable force-install policy locations.
; Register the host in the Chromium and Chrome-compatible fallback locations;
; the extension itself must be distributed through the vendor store or enterprise console.
Root: HKLM64; Subkey: "Software\Chromium\NativeMessagingHosts\com.hzy9738.sidechat"; ValueType: string; ValueName: ""; ValueData: "{app}\native-host.json"; Tasks: 360safe 360speed qqbrowser; Flags: uninsdeletekey
Root: HKLM64; Subkey: "Software\Google\Chrome\NativeMessagingHosts\com.hzy9738.sidechat"; ValueType: string; ValueName: ""; ValueData: "{app}\native-host.json"; Tasks: 360safe 360speed qqbrowser; Flags: uninsdeletekey

[Code]
const
  ExtensionId = '{#ExtensionId}';

function ChromeInstalled: Boolean;
begin
  Result := RegKeyExists(HKLM64, 'Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe') or
            RegKeyExists(HKCU, 'Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe') or
            FileExists(ExpandConstant('{localappdata}\Google\Chrome\Application\chrome.exe'));
end;

function EdgeInstalled: Boolean;
begin
  Result := RegKeyExists(HKLM64, 'Software\Microsoft\Windows\CurrentVersion\App Paths\msedge.exe') or
            FileExists(ExpandConstant('{pf}\Microsoft\Edge\Application\msedge.exe')) or
            FileExists(ExpandConstant('{localappdata}\Microsoft\Edge\Application\msedge.exe'));
end;

function BraveInstalled: Boolean;
begin
  Result := RegKeyExists(HKLM64, 'Software\Microsoft\Windows\CurrentVersion\App Paths\brave.exe') or
            FileExists(ExpandConstant('{localappdata}\BraveSoftware\Brave-Browser\Application\brave.exe'));
end;

function Browser360SafeInstalled: Boolean;
begin
  Result := FileExists(ExpandConstant('{userappdata}\360se6\Application\360se.exe')) or
            FileExists(ExpandConstant('{localappdata}\360se6\Application\360se.exe')) or
            FileExists(ExpandConstant('{pf32}\360\360se6\Application\360se.exe'));
end;

function Browser360SpeedInstalled: Boolean;
begin
  Result := FileExists(ExpandConstant('{localappdata}\360Chrome\Chrome\Application\360chrome.exe')) or
            FileExists(ExpandConstant('{pf32}\360\360Chrome\Chrome\Application\360chrome.exe'));
end;

function QQBrowserInstalled: Boolean;
begin
  Result := FileExists(ExpandConstant('{localappdata}\Tencent\QQBrowser\Application\QQBrowser.exe')) or
            FileExists(ExpandConstant('{pf32}\Tencent\QQBrowser\QQBrowser.exe'));
end;

function NextFreePolicyValue(const Key: String): String;
var
  Names: TArrayOfString;
  I, N: Integer;
begin
  N := 1;
  if RegGetValueNames(HKLM64, Key, Names) then
    for I := 0 to GetArrayLength(Names) - 1 do
      if StrToIntDef(Names[I], 0) >= N then N := StrToIntDef(Names[I], 0) + 1;
  Result := IntToStr(N);
end;

function ChromePolicyValueName(Param: String): String;
begin
  Result := NextFreePolicyValue('Software\Policies\Google\Chrome\ExtensionInstallForcelist');
end;

function EdgePolicyValueName(Param: String): String;
begin
  Result := NextFreePolicyValue('Software\Policies\Microsoft\Edge\ExtensionInstallForcelist');
end;

function BravePolicyValueName(Param: String): String;
begin
  Result := NextFreePolicyValue('Software\Policies\BraveSoftware\Brave\ExtensionInstallForcelist');
end;

procedure CurStepChanged(CurStep: TSetupStep);
var
  Manifest: String;
begin
  if CurStep = ssPostInstall then
  begin
    Manifest := '{' + #13#10 +
      '  "name": "com.hzy9738.sidechat",' + #13#10 +
      '  "description": "安能助手 Native Messaging Host",' + #13#10 +
      '  "path": "' + AddBackslash(ExpandConstant('{app}')) + 'anneng-assistant-host.exe",' + #13#10 +
      '  "type": "stdio",' + #13#10 +
      '  "allowed_origins": ["chrome-extension://' + ExtensionId + '/"]' + #13#10 +
      '}' + #13#10;
    StringChangeEx(Manifest, '\', '\\', True);
    SaveStringToFile(ExpandConstant('{app}\native-host.json'), Manifest, False);
  end;
end;
