#!/usr/bin/env bash
# Adds the permission strings iOS needs so the share sheet's "Save Video"/"Save Image"
# and the camera option in the file picker don't crash the app.
set -euo pipefail
PLIST="ios/App/App/Info.plist"
set_key () {
  /usr/libexec/PlistBuddy -c "Set :$1 $2" "$PLIST" 2>/dev/null || /usr/libexec/PlistBuddy -c "Add :$1 $3 $2" "$PLIST"
}
set_key NSPhotoLibraryAddUsageDescription "Save converted photos and videos to your library." string
set_key NSPhotoLibraryUsageDescription "Pick photos and videos to convert." string
set_key NSCameraUsageDescription "Take a photo or video to convert." string
set_key NSMicrophoneUsageDescription "Record video with sound to convert." string
set_key UIFileSharingEnabled true bool
set_key LSSupportsOpeningDocumentsInPlace true bool
set_key ITSAppUsesNonExemptEncryption false bool
echo "Info.plist updated"
