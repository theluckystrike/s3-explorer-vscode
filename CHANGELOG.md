# Changelog

## 0.1.0 (2026-11-09)

- First release: browse S3 buckets page by page (1,000 keys per request, Load more, find and filter by prefix).
- Connections: AWS profiles from ~/.aws (keys, credential_process, roles, SSO after aws sso login), access keys for AWS, Cloudflare R2, MinIO, Backblaze B2, Wasabi, DigitalOcean Spaces and other S3-compatible services, and environment variables. Keys go to SecretStorage.
- Open objects read-only (text in an editor tab, binary files in the matching viewer), first 1 MB of large text, Edit and Upload with a confirmation.
- Upload files and folders (drag and drop too), multipart with progress, Cancel and resume; download files and folders, safe against `../` keys.
- Copy, move, rename and delete objects and folders; every delete and overwrite lists the keys and asks first.
- Details: metadata, tags, versions (open, download, restore), presigned GET and PUT URLs.
- Folder sync in both directions with a dry-run plan.
- Zovo Pro extras with 3 free tries each: scheduled sync, copy between connections, size and cost report.
- Rating ask v2.2, support links and related Zovo tools.
- Zovo Pro is USD 19 once (the "$19 one time" GitHub Sponsors tier).

