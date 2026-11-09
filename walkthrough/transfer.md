# Upload, download and edit

- Drag files or folders from the Explorer onto a bucket or folder, or use "Upload Files" and "Upload Folder".
- Files of 16 MB or more upload in parts with progress and Cancel. A stopped upload stays under "Unfinished uploads": Resume sends only the missing parts.
- "Download" saves objects or whole folders. A key such as `../../x` never writes outside the folder you chose.
- "Edit and Upload" opens a local copy. When you save, a dialog shows the key and size and asks before it replaces the object. It warns you if the object changed on the server meanwhile.
- Delete, rename, copy, move and every overwrite list the keys and ask first.
