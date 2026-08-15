; Custom NSIS hooks for OpenModelDB Upscaler

!macro customHeader
  ShowInstDetails show
  ShowUnInstDetails show
!macroend

!macro customInstall
  SetDetailsPrint both
  DetailPrint "Installing OpenModelDB Upscaler application files…"
  DetailPrint "AI runtime (PyTorch) downloads on first launch — not during this Setup."
!macroend

!macro customUnInstall
  ; Keep data during in-place updates / reinstalls.
  ${if} ${isUpdated}
    Goto unKeepDone
  ${endIf}

  SetShellVarContext current
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Remove the AI runtime, settings, and download cache as well?$\r$\n$\r$\nYes = delete AppData + Downloads\OpenModelDB-Upscaler-Cache$\r$\nNo = keep them (faster next install)" \
    /SD IDNO IDNO unKeepData IDYES unWipeData

  unWipeData:
    DetailPrint "Removing application data (AI runtime, settings)…"
    RMDir /r "$APPDATA\${APP_PACKAGE_NAME}"
    RMDir /r "$LOCALAPPDATA\${APP_PACKAGE_NAME}"
    DetailPrint "Removing download cache…"
    RMDir /r "$PROFILE\Downloads\OpenModelDB-Upscaler-Cache"
    Goto unKeepDone

  unKeepData:
    DetailPrint "Keeping AI runtime, settings, and download cache."

  unKeepDone:
!macroend
