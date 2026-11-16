# EmDash image optimization — migration-agent guidance

This integration is EmDash's own image optimization. It replaces the image-optimization
plug-ins a site may have used before moving to EmDash.

Use `npx jpegxl add emdash` in the target EmDash site's folder. Preserve its native
media repository, database, local/R2 storage, and application configuration. The
plug-in implements no other plug-in's API, settings import or database schema, and must
not be described as a drop-in for one.

For media already copied into EmDash local/R2 storage **with ready media records**
(an imported site's included), the Media page's **Convert N older images** discovers
them from the native paginated media catalog; the upload hook is not required.
Confirm source binding and preserved source bytes before conversion.

When plugin MCP tools are enabled in EmDash (`mcp:tools` or `mcp:tools:rapier-media`),
AI agents can run the integration directly over `/_emdash/api/mcp`:
- `rapier-media__convertLibrary` (`media:upload`): start, pause, resume, advance, or cancel converting ready JPEG and PNG media to JPEG XL.
- `rapier-media__libraryProgress` (`media:read`): read library conversion counts, active image job state, and originals policy progress.
- `rapier-media__bytesSaved` (`media:read`): inspect original bytes, delivered JPEG XL bytes, bytes saved, and physical storage bytes.
- `rapier-media__keepOriginalJpegs` (`media:upload`, `destructive: true`): read or update **Keep original JPEG files**; turning it off needs `confirm: true` and the policy ID just read.

JPEG originals may be archived reversibly only under a verified host policy. Worker
operations go through the single measured `workerAdmission` reader; rows or sizes
not certified are browser work. Never infer Paid/Free from errors or bypass the
**Keep original JPEG files** physical custody switch. The public registry listing is
owner-controlled and is not the migration-agent description.
