; OteWork 插件集 Windows 安装程序（NSIS / Modern UI 2）
;
; 编译由 tools/build-installers.mjs 驱动，通过 /D 传入路径与版本：
;   makensis /DSOURCE=<payload> /DOUTFILE=<exe> /DASSETS=<素材> /DAPP_VERSION=1.0.0 OteWork.nsi
;
; 安装位置在用户目录（$LOCALAPPDATA\OteWork），不申请管理员；真正的 DSH 配置写入交给
; 随包的 install.mjs——与 mac 安装器、zip 包共用同一份逻辑，三边行为一致。

Unicode true
SetCompressor /SOLID lzma
SetCompressorDictSize 16

!include MUI2.nsh
!include LogicLib.nsh

!define APP_NAME "OteWork"
!define APP_PUBLISHER "OTE Work"
!define APP_TAG "DSH 插件集"
!define APP_SLUG "OteWork"

Name "${APP_NAME} ${APP_VERSION}"
OutFile "${OUTFILE}"
InstallDir "$LOCALAPPDATA\OteWork"
InstallDirRegKey HKCU "Software\OteWork" "InstallDir"
RequestExecutionLevel user
ShowInstDetails show
ShowUninstDetails show

VIProductVersion "${APP_VERSION}.0"
VIAddVersionKey /LANG=2052 "ProductName" "${APP_NAME} ${APP_TAG}"
VIAddVersionKey /LANG=2052 "CompanyName" "${APP_PUBLISHER}"
VIAddVersionKey /LANG=2052 "FileDescription" "${APP_NAME} 安装程序"
VIAddVersionKey /LANG=2052 "FileVersion" "${APP_VERSION}"
VIAddVersionKey /LANG=2052 "LegalCopyright" "MIT License"
VIAddVersionKey /LANG=2052 "OriginalFilename" "${APP_SLUG}-Setup.exe"

!define MUI_ABORTWARNING
!define MUI_ICON "${ASSETS}\installer.ico"
!define MUI_UNICON "${ASSETS}\installer.ico"
!define MUI_HEADERIMAGE
!define MUI_HEADERIMAGE_BITMAP "${ASSETS}\nsis-header.bmp"
!define MUI_HEADERIMAGE_BITMAP_NOSTRETCH
!define MUI_WELCOMEFINISHPAGE_BITMAP "${ASSETS}\nsis-welcome.bmp"
!define MUI_UNWELCOMEFINISHPAGE_BITMAP "${ASSETS}\nsis-welcome.bmp"

!define MUI_WELCOMEPAGE_TITLE "安装 ${APP_NAME} ${APP_TAG}"
!define MUI_WELCOMEPAGE_TEXT "这个向导会把 ${APP_NAME} 的插件装进你的 DeepSeek Harness。$\r$\n$\r$\n安装程序会做三件事：复制插件到 DSH 的资料目录、把插件写进每个 profile 的启用列表、刷新模块链接。$\r$\n$\r$\n装完请完全退出并重新启动 DeepSeek Harness。$\r$\n$\r$\n点「下一步」继续。"

!define MUI_LICENSEPAGE_TEXT_TOP "许可条款"
!define MUI_LICENSEPAGE_TEXT_BOTTOM "接受条款后点「我接受」继续。"

!define MUI_DIRECTORYPAGE_TEXT_TOP "插件文件装到这里。DSH 侧不需要这个路径，配置写入由随包脚本完成。"

!define MUI_FINISHPAGE_TITLE "${APP_NAME} 安装完成"
!define MUI_FINISHPAGE_TEXT "插件已就位。$\r$\n$\r$\n下一步：完全退出 DeepSeek Harness（不是刷新页面），再重新启动，插件才会被加载。"
!define MUI_FINISHPAGE_LINK "打开插件目录"
!define MUI_FINISHPAGE_LINK_LOCATION "$INSTDIR"

!insertmacro MUI_PAGE_WELCOME
!insertmacro MUI_PAGE_LICENSE "${SOURCE}\LICENSE"
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH

!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES

!insertmacro MUI_LANGUAGE "SimpChinese"
!insertmacro MUI_LANGUAGE "English"

Var NodePath      ; node 所在目录；命中 PATH 时是 "__PATH__"，完全找不到是空串
Var ExtraArgs     ; 传给 install.mjs 的额外参数

Function .onInit
  ; 开场淡入淡出的品牌闪屏：显示 1.5s，前 0.4s 淡入、后 0.4s 淡出（颜色 0x00BBGGRR）
  AdvSplash::show 1500 400 400 -1 0x0014160B "${ASSETS}\nsis-splash.bmp"
  Pop $0
FunctionEnd

!macro DefFindNode FN
Function ${FN}
  StrCpy $NodePath ""
  ReadRegStr $1 HKLM "SOFTWARE\Node.js" "InstallPath"
  ${If} $1 != ""
  ${AndIf} ${FileExists} "$1\node.exe"
    StrCpy $NodePath "$1"
    Return
  ${EndIf}
  ReadRegStr $1 HKCU "SOFTWARE\Node.js" "InstallPath"
  ${If} $1 != ""
  ${AndIf} ${FileExists} "$1\node.exe"
    StrCpy $NodePath "$1"
    Return
  ${EndIf}
  ${If} ${FileExists} "$PROGRAMFILES64\nodejs\node.exe"
    StrCpy $NodePath "$PROGRAMFILES64\nodejs"
    Return
  ${EndIf}
  ${If} ${FileExists} "$PROGRAMFILES32\nodejs\node.exe"
    StrCpy $NodePath "$PROGRAMFILES32\nodejs"
    Return
  ${EndIf}
  ${If} ${FileExists} "$LOCALAPPDATA\Programs\nodejs\node.exe"
    StrCpy $NodePath "$LOCALAPPDATA\Programs\nodejs"
    Return
  ${EndIf}
  nsExec::ExecToStack 'cmd /c node --version'
  Pop $1
  Pop $2
  ${If} $1 == "0"
    DetailPrint "PATH 上的 Node.js：$2"
    StrCpy $NodePath "__PATH__"
  ${EndIf}
FunctionEnd
!macroend

!macro DefRunScript FN
Function ${FN}
  ${If} $NodePath == "__PATH__"
    nsExec::ExecToLog 'cmd /c node "$INSTDIR\install.mjs" --root "$INSTDIR" $ExtraArgs'
  ${Else}
    nsExec::ExecToLog '"$NodePath\node.exe" "$INSTDIR\install.mjs" --root "$INSTDIR" $ExtraArgs'
  ${EndIf}
  Pop $R9
FunctionEnd
!macroend

; 卸载器里的函数必须带 un. 前缀，所以同一段逻辑插两次
!insertmacro DefFindNode FindNode
!insertmacro DefFindNode un.FindNode
!insertmacro DefRunScript RunScript
!insertmacro DefRunScript un.RunScript

Section "${APP_NAME}"
  SetShellVarContext current
  SetOutPath "$INSTDIR"
  Banner::show /NOUNLOAD "${ASSETS}\nsis-banner-01.bmp"
  DetailPrint "复制插件文件到 $INSTDIR"
  File /r /x ".DS_Store" "${SOURCE}\*.*"

  Banner::show /NOUNLOAD "${ASSETS}\nsis-banner-04.bmp"
  DetailPrint "查找 Node.js"
  Call FindNode

  Banner::show /NOUNLOAD "${ASSETS}\nsis-banner-07.bmp"
  ${If} $NodePath == ""
    DetailPrint "没有找到 Node.js，跳过配置写入"
    MessageBox MB_ICONEXCLAMATION|MB_OK "没有找到 Node.js，插件文件已复制到：$\r$\n$INSTDIR$\r$\n$\r$\n装好 Node.js 后，在 PowerShell 里运行下面这行把配置补上：$\r$\nnode $\"$INSTDIR\install.mjs$\" --root $\"$INSTDIR$\""
  ${Else}
    DetailPrint "写入 DSH 插件配置"
    StrCpy $ExtraArgs ""
    Call RunScript
    ${If} $R9 != "0"
      DetailPrint "配置写入失败，脚本返回 $R9"
      MessageBox MB_ICONEXCLAMATION|MB_OK "写入 DSH 配置失败（返回 $R9）。$\r$\n$\r$\n插件文件已复制到：$\r$\n$INSTDIR$\r$\n$\r$\n常见原因是 DeepSeek Harness 还没装或没启动过（要先有 profile 目录）。确认后在 PowerShell 里重跑：$\r$\nnode $\"$INSTDIR\install.mjs$\" --root $\"$INSTDIR$\""
    ${Else}
      DetailPrint "配置写入完成"
    ${EndIf}
  ${EndIf}

  Banner::show /NOUNLOAD "${ASSETS}\nsis-banner-10.bmp"
  WriteUninstaller "$INSTDIR\uninstall.exe"
  WriteRegStr HKCU "Software\OteWork" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\OteWork" "Version" "${APP_VERSION}"
  CreateDirectory "$SMPROGRAMS\${APP_NAME}"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk" "$INSTDIR\uninstall.exe"
  CreateShortCut "$SMPROGRAMS\${APP_NAME}\${APP_NAME} 安装说明.lnk" "$INSTDIR\INSTALL.md"
  Banner::destroy
SectionEnd

Function un.onInit
  MessageBox MB_YESNO|MB_ICONQUESTION "确定卸载 ${APP_NAME} 吗？$\r$\n$\r$\n会一并移除写进 DSH profile 的插件配置（插件本体与本地资料目录也会清掉）。" IDYES +2
  Abort
FunctionEnd

Section "Uninstall"
  SetShellVarContext current
  StrCpy $ExtraArgs "--uninstall"
  DetailPrint "查找 Node.js"
  Call un.FindNode
  ${If} $NodePath == ""
    DetailPrint "没有找到 Node.js，无法自动清理 DSH 配置"
    MessageBox MB_ICONEXCLAMATION|MB_OK "没有找到 Node.js，DSH profile 里的插件配置没能自动清掉。$\r$\n$\r$\n装好 Node.js 后手动清理：删掉 profile 的 package.json 里那些 dsh-* 依赖与 dsh.profile.bundles 里的对应项，再删掉 DSH 资料目录下 local-plugins 里的同名目录。"
  ${Else}
    DetailPrint "清理 DSH 插件配置"
    Call un.RunScript
  ${EndIf}
  Delete "$SMPROGRAMS\${APP_NAME}\卸载 ${APP_NAME}.lnk"
  Delete "$SMPROGRAMS\${APP_NAME}\${APP_NAME} 安装说明.lnk"
  RMDir "$SMPROGRAMS\${APP_NAME}"
  DeleteRegKey HKCU "Software\OteWork"
  RMDir /r "$INSTDIR"
SectionEnd
