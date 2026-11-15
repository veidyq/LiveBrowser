; LiveBrowser setup — per-user, без прав администратора.
; Сборка: build\nsis\nsis-3.10\makensis.exe installer\livebrowser.nsi (из корня проекта)
Unicode true
!include "MUI2.nsh"
!include "LogicLib.nsh"

!define APPNAME "LiveBrowser"
!define VERSION "1.0.0"
!define WEBVIEW2_GUID "{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}"

Name "${APPNAME} ${VERSION}"
OutFile "LiveBrowser-Setup-${VERSION}.exe"
InstallDir "$LOCALAPPDATA\Programs\LiveBrowser"
InstallDirRegKey HKCU "Software\LiveBrowser" "InstallDir"
RequestExecutionLevel user
SetCompressor /SOLID lzma

VIProductVersion "1.0.0.0"
VIAddVersionKey "ProductName" "LiveBrowser"
VIAddVersionKey "FileVersion" "${VERSION}"
VIAddVersionKey "ProductVersion" "${VERSION}"
VIAddVersionKey "FileDescription" "LiveBrowser Setup"

!define MUI_ABORTWARNING
!insertmacro MUI_PAGE_DIRECTORY
; Ярлыки: по умолчанию только «Пуск». На рабочий стол — по желанию, чтобы
; установщик не мусорил у тех, кто этого не хочет.
!define MUI_PAGE_CUSTOMFUNCTION_SHOW ShortcutsPageShow
!insertmacro MUI_PAGE_COMPONENTS
!insertmacro MUI_PAGE_INSTFILES
!define MUI_TEXTFINISHLAUNCH_APP "$(RunApp)"
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_UNPAGE_CONFIRM
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro MUI_LANGUAGE "Russian"
!insertmacro MUI_LANGUAGE "English"

LangString RunApp ${LANG_RUSSIAN} "Запустить ${APPNAME}"
LangString RunApp ${LANG_ENGLISH} "Run ${APPNAME}"
LangString SecCore ${LANG_RUSSIAN} "LiveBrowser (обязательно)"
LangString SecCore ${LANG_ENGLISH} "LiveBrowser (required)"
LangString SecDesktop ${LANG_RUSSIAN} "Ярлык на рабочем столе"
LangString SecDesktop ${LANG_ENGLISH} "Desktop shortcut"
LangString SecDesktopHint ${LANG_RUSSIAN} "Добавить значок ${APPNAME} на рабочий стол. Ярлык в меню «Пуск» создаётся всегда."
LangString SecDesktopHint ${LANG_ENGLISH} "Add a ${APPNAME} icon to the desktop. The Start menu shortcut is always created."

; Чистим за собой: диагностический лог и служебные файлы предыдущей портативной
; сборки не должны доехать до нового пользователя.
!define DATA "profile settings.json theme.json session.json window.json downloads.json history.jsonl"
!define CRUFT "debug.log srv*.log shot*.png *.pdb"

; ---- WebView2 Runtime: установлен? ----
Function WebView2Installed
  ClearErrors
  ReadRegStr $0 HKLM "SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_GUID}" "pv"
  ${If} $0 == ""
    ReadRegStr $0 HKCU "Software\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_GUID}" "pv"
  ${EndIf}
  ${If} $0 == ""
    ReadRegStr $0 HKLM "SOFTWARE\Microsoft\EdgeUpdate\Clients\${WEBVIEW2_GUID}" "pv"
  ${EndIf}
  ${If} $0 == ""
    Push 0
  ${Else}
    Push 1
  ${EndIf}
FunctionEnd

; Иконка установщика и деинсталлятора: тот же знак, что в exe.  Путь от корня
; проекта: makensis запускают именно оттуда (см. голову файла).
Icon "..\host\app.ico"
UninstallIcon "..\host\app.ico"

Section "$(SecCore)" SEC01
  SectionIn RO
  SetOutPath "$INSTDIR"

  ; Дистрибутив ставится с чистого листа: состояние прежней (портативной)
  ; сборки в dist\ не должно доехать до нового пользователя.  Фикстуры
  ; проб (_sc, _heavy, _ads) в установку не идут — они нужны только этапу
  ; диагностики.  NSIS не умеет переносить строку, поэтому исключения в
  ; одном File, каким бы длинным он ни был.
  File /r /x profile /x debug.log /x _sc /x _heavy /x _ads /x settings.json /x theme.json /x session.json /x window.json /x downloads.json /x history.jsonl /x "*.pdb" ..\dist\*.*

  ; WebView2 Runtime (Evergreen) — нужен каждому WebView2-приложению.
  Call WebView2Installed
  Pop $1
  ${If} $1 == 0
    DetailPrint "Installing WebView2 Runtime..."
    File /oname=$PLUGINSDIR\webview2setup.exe ..\build\innosetup\MicrosoftEdgeWebview2Setup.exe
    ExecWait '"$PLUGINSDIR\webview2setup.exe" /silent /install' $2
    Call WebView2Installed
    Pop $1
    ${If} $1 == 0
      DetailPrint "WebView2 Runtime still missing"
      MessageBox MB_ICONEXCLAMATION|MB_OK "WebView2 Runtime не удалось установить. Установите его с https://developer.microsoft.com/microsoft-edge/webview2/ и запустите установщик снова."
    ${Else}
      DetailPrint "WebView2 Runtime installed"
    ${EndIf}
  ${EndIf}

  ; Ярлык в «Пуск» есть всегда: без него приложение не найти.
  CreateDirectory "$SMPROGRAMS\LiveBrowser"
  CreateShortCut "$SMPROGRAMS\LiveBrowser\${APPNAME}.lnk" "$INSTDIR\LiveBrowser.exe" "" "$INSTDIR\LiveBrowser.exe" 0
  ; След установки: путь, по которому реально легли файлы.  Выбор папки
  ; приходит от установщика через /D или InstallDirRegKey; этот файл
  ; показывает, куда он сработал, и его же видно в файловой системе.
  FileOpen $9 "$INSTDIR\install-path.txt" w
  FileWrite $9 "$INSTDIR"
  FileClose $9
SectionEnd

; Рабочий стол — отдельной секцией, чтобы была галочка.  По умолчанию выкл.
Section "$(SecDesktop)" SEC_DESKTOP
  CreateShortCut "$DESKTOP\${APPNAME}.lnk" "$INSTDIR\LiveBrowser.exe" "" "$INSTDIR\LiveBrowser.exe" 0
SectionEnd

Section "-post"
  ; Деинсталлятор + запись в Uninstall (HKCU — без админа).
  WriteUninstaller "$INSTDIR\Uninstall.exe"
  WriteRegStr HKCU "Software\LiveBrowser" "InstallDir" "$INSTDIR"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayName" "${APPNAME}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayVersion" "${VERSION}"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "Publisher" "LiveBrowser"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "DisplayIcon" "$INSTDIR\LiveBrowser.exe"
  WriteRegStr HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "UninstallString" "$INSTDIR\Uninstall.exe"
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "NoModify" 1
  WriteRegDWORD HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}" "NoRepair" 1
SectionEnd

Section "Uninstall"
  ; Данные пользователя (profile\, settings.json, theme.json…) выносим,
  ; сносим папку и возвращаем их на место: переустановка не должна терять
  ; настройки, закладки и входы, а RMDir /r иначе снёс бы их вместе с exe.
  Delete "$SMPROGRAMS\LiveBrowser\${APPNAME}.lnk"
  RMDir "$SMPROGRAMS\LiveBrowser"
  Delete "$DESKTOP\${APPNAME}.lnk"
  DeleteRegKey HKCU "Software\Microsoft\Windows\CurrentVersion\Uninstall\${APPNAME}"
  DeleteRegKey HKCU "Software\LiveBrowser"

  CreateDirectory "$INSTDIR\..\LiveBrowser-userdata-tmp"
  ${If} ${FileExists} "$INSTDIR\profile"
    Rename "$INSTDIR\profile" "$INSTDIR\..\LiveBrowser-userdata-tmp\profile"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\settings.json"
    Rename "$INSTDIR\settings.json" "$INSTDIR\..\LiveBrowser-userdata-tmp\settings.json"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\theme.json"
    Rename "$INSTDIR\theme.json" "$INSTDIR\..\LiveBrowser-userdata-tmp\theme.json"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\downloads.json"
    Rename "$INSTDIR\downloads.json" "$INSTDIR\..\LiveBrowser-userdata-tmp\downloads.json"
  ${EndIf}
  RMDir /r "$INSTDIR"
  ${If} ${FileExists} "$INSTDIR\..\LiveBrowser-userdata-tmp\profile"
    Rename "$INSTDIR\..\LiveBrowser-userdata-tmp\profile" "$INSTDIR\profile"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\..\LiveBrowser-userdata-tmp\settings.json"
    Rename "$INSTDIR\..\LiveBrowser-userdata-tmp\settings.json" "$INSTDIR\settings.json"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\..\LiveBrowser-userdata-tmp\theme.json"
    Rename "$INSTDIR\..\LiveBrowser-userdata-tmp\theme.json" "$INSTDIR\theme.json"
  ${EndIf}
  ${If} ${FileExists} "$INSTDIR\..\LiveBrowser-userdata-tmp\downloads.json"
    Rename "$INSTDIR\..\LiveBrowser-userdata-tmp\downloads.json" "$INSTDIR\downloads.json"
  ${EndIf}
  RMDir "$INSTDIR\..\LiveBrowser-userdata-tmp"
SectionEnd

; Описание галочки на странице компонентов.
!insertmacro MUI_FUNCTION_DESCRIPTION_BEGIN
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC01} "$(SecCoreDesc)"
  !insertmacro MUI_DESCRIPTION_TEXT ${SEC_DESKTOP} "$(SecDesktopHint)"
!insertmacro MUI_FUNCTION_DESCRIPTION_END

; Страница компонентов: подпись к обязательной секции и фокус на галочке
; рабочего стола, чтобы выбор был виден сразу, а не спрятан в списке.
Function ShortcutsPageShow
  !insertmacro MUI_HEADER_TEXT "$(SecHeader)" "$(SecHeaderHint)"
FunctionEnd

LangString SecCoreDesc ${LANG_RUSSIAN} "Сам браузер и среда WebView2; снять нельзя."
LangString SecCoreDesc ${LANG_ENGLISH} "The browser itself and the WebView2 runtime; cannot be cleared."
LangString SecHeader ${LANG_RUSSIAN} "Что установить"
LangString SecHeader ${LANG_ENGLISH} "Choose components"
LangString SecHeaderHint ${LANG_RUSSIAN} "Ярлык в «Пуск» создаётся всегда; на рабочий стол — по желанию."
LangString SecHeaderHint ${LANG_ENGLISH} "A Start menu shortcut is always created; the desktop one is optional."
