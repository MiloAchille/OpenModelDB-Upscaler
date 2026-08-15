; Custom NSIS hooks for OpenModelDB Upscaler
;
; Upgrades: electron-builder detects the same appId registry install, runs the
; old uninstaller with --updated / KEEP_APP_DATA (program files only), then
; writes the new build into the same $INSTDIR. AppData runtime/settings stay.
; Manual uninstall is not required; do not change appId once shipped.

!macro customHeader
  ShowInstDetails show
  ShowUnInstDetails show
!macroend

!macro customInstall
  SetDetailsPrint both
  ${if} ${isUpdated}
    DetailPrint "Updating existing install — overwriting application files in place…"
    DetailPrint "Keeping AI runtime, settings, and imported models (AppData)."
  ${else}
    DetailPrint "Installing OpenModelDB Upscaler application files…"
  ${endIf}
  DetailPrint "AI runtime (PyTorch) downloads on first launch — not during this Setup."
!macroend

!macro customUnInstall
  ; Keep data during in-place updates / reinstalls (installer passes --updated).
  ${if} ${isUpdated}
    DetailPrint "Upgrade uninstall — removing old program files only (AppData kept)."
    Goto unKeepDone
  ${endIf}

  SetShellVarContext current
  MessageBox MB_YESNO|MB_ICONQUESTION \
    "Remove the AI runtime, settings, and download cache as well?$\r$\n$\r$\nYes = delete AppData + Downloads\OpenModelDB-Upscaler-Cache$\r$\nNo = keep them (faster next install)$\r$\n$\r$\nA selected ComfyUI / external env is never deleted." \
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
