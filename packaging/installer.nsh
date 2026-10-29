!macro customCheckAppRunning
  ${If} ${FileExists} "$INSTDIR\resources\app\src\desktop\installer.cjs"
    System::Call 'kernel32::GetCurrentProcessId() i .r2'
    nsExec::ExecToStack '"$INSTDIR\resources\runtime\node.exe" "$INSTDIR\resources\app\src\desktop\installer.cjs" prepare "$2"'
    Pop $0
    Pop $1
    ${If} $0 != 0
      MessageBox MB_OK|MB_ICONSTOP "$1" /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
!macroend

!macro customInstall
  CreateShortcut "$SMPROGRAMS\AFClip Content Library.lnk" "$INSTDIR\AFClip.exe" "--afclip-role=library"
  nsExec::ExecToStack '"$INSTDIR\resources\runtime\node.exe" "$INSTDIR\resources\app\src\desktop\installer.cjs" install'
  Pop $0
  Pop $1
  ${If} $0 != 0
    DetailPrint "$1"
    MessageBox MB_OK|MB_ICONEXCLAMATION "AFClip was installed, but its command-line shortcuts could not be added to PATH. You can open AFClip from Start. Run this installer again to repair the shortcuts.$\r$\n$\r$\n$1" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend

!macro customUnInstall
  Delete "$SMPROGRAMS\AFClip Content Library.lnk"
  nsExec::ExecToStack '"$INSTDIR\resources\runtime\node.exe" "$INSTDIR\resources\app\src\desktop\installer.cjs" uninstall'
  Pop $0
  Pop $1
  SendMessage ${HWND_BROADCAST} ${WM_SETTINGCHANGE} 0 "STR:Environment" /TIMEOUT=5000
!macroend
