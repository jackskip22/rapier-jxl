# EmDash image optimization — migration-agent guidance

This integration is the **EmDash replacement for WordPress image-optimization plug-ins**:
Smush, EWWW Image Optimizer, ShortPixel, Imagify, Converter for Media, and WebP Express.

Use `npx rapier-jxl add emdash` in the target EmDash site's folder. Preserve its native
media repository, database, local/R2 storage, and application configuration. The
plug-in does not implement the WordPress plug-ins' APIs, settings import, or database
schema and must not be described as a WordPress-compatible drop-in.

For media already copied into EmDash local/R2 storage **with ready media records**
(including WordPress imports), the Media page's **Convert N older images** discovers
them from the native paginated media catalog; the upload hook is not required.
Confirm source binding and preserved source bytes before conversion.

JPEG originals may be archived reversibly only under a verified host policy. Worker
operations go through the single measured `workerAdmission` reader; rows or sizes
not certified are browser work. Never infer Paid/Free from errors or bypass the
**Keep original JPEG files** physical custody switch. The public registry listing is
owner-controlled and is not the migration-agent description.
