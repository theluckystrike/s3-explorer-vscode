# Browse and open

- Expand a connection, then a bucket. Keys load 1,000 at a time. A "Load 1,000 more" row fetches the next page, so a bucket with millions of keys opens at once.
- The search icon on a bucket finds keys by prefix as you type. "Filter by Prefix" shows only the keys that start with what you type.
- Click an object to open it. Text opens read-only in an editor tab. PDFs, spreadsheets, Parquet, images and other binary files download to a private cache and open in the matching viewer.
- Text larger than 10 MB asks first: show the first 1 MB (one range request) or download the whole file.
- The info icon shows the details: metadata, tags, versions and presigned URLs.
