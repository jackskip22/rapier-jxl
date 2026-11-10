# JPEG XL Image Optimizer for EmDash

Automatic JPEG XL for every image.

Every upload gets a JPEG XL copy, served to compatible browsers. Browsers which cannot display it get served the original file.

JPEGs are kept as JPEG XL, then converted back losslessly when needed. Other formats always keep the original file.

Works with Cloudflare R2 and Node local storage. The native `rapier-jxl/emdash` integration uses the site's existing storage. It selects a full-size JPEG XL representation for delivery only when it meets the selected goal, is smaller, and fits the selected size limit.

The separate [Registry companion](registry/README.md), `@rapier.website/jxl`, is a setup guide. Installing the guide alone does not enable image conversion or delivery.

## Finish setup

### Command

Just run this in your site's folder:

```sh
npx rapier-jxl add emdash
```

The command checks the installation and updates `astro.config.mjs`, preserving the existing options. On Cloudflare it asks **Workers Paid?** once, unless an explicit 10 ms or 30,000 ms native allowance is already recorded. Answer for the plan you already use. Node needs no question or Workers flag.

For a coding agent, CI or another noninteractive terminal, choose explicitly:

```sh
npx rapier-jxl add emdash --workers-paid
npx rapier-jxl add emdash --workers-free
```

Use one flag. Paid records `{cpuLimitMs: 30000}` in the third `jxl` argument and sets `limits.cpu_ms` to `30000` in the site's source Wrangler config. Free records `{cpuLimitMs: 10}`, retains physical JPEG originals, and removes an existing custom Wrangler CPU limit while preserving other settings. The choice configures the local project; account plan changes and remote deployment remain separate actions.

If this integration already records a 30,000 ms allowance, setup refuses a switch to Free before installing packages or writing config. Run `npx rapier-jxl remove emdash` under the existing allowance so archived originals are restored, then run `npx rapier-jxl add emdash --workers-free`. A fresh integration may choose either plan even when an unrelated Wrangler CPU limit already exists.

Automatic edits support one ordinary `wrangler.json` or `wrangler.jsonc` in the site folder. Comments, other options and file permissions are retained. Generated configs, TOML, multiple source configs, named environments and custom config/environment selectors require explicit manual setup; the command explains the part it cannot safely choose. It rechecks source files and deployment selectors after dependency installation and before replacing a config. Rebuild and deploy through the site's normal workflow after setup succeeds.

### Coding agent

Or tell your coding agent:

```text
Add rapier-jxl to my EmDash site with npx rapier-jxl add emdash.
```

### By hand

```sh
npm install rapier-jxl @cloudflare/kumo@2.6.0
```

Kumo 2.6.0 matches EmDash 1.4's admin. For a newer host, use the Kumo version resolved by its installed EmDash admin.

In `astro.config.mjs`, add the import and replace `emdash(options)` with `jxl(emdash, options)`. Keep the entire existing options object:

```js
import {jxl} from 'rapier-jxl/emdash';

jxl(emdash, options)
```

Here, `options` means the site's existing EmDash options, written inline or held in a variable. This two-argument form is suitable for default Node hosting. For Cloudflare, add the explicit third argument: `{cpuLimitMs: 10}` for Free or `{cpuLimitMs: 30000}` for Paid. Match a Paid allowance with `limits.cpu_ms: 30000` in the intended source Wrangler configuration or environment; Free needs no custom CPU limit. See [Wrangler's limits configuration](https://developers.cloudflare.com/workers/wrangler/configuration/#limits). Keep the Astro adapter, database, media storage, other plugins, and `react()` integration. Add `@astrojs/react` if it is missing.

Storage must be an EmDash `r2()` descriptor from `@emdash-cms/cloudflare` or `local()` from `emdash/astro`. Preserve its bindings or local directory and base URL. The local wrapper uses one server process per persistent storage directory. See [EmDash's storage documentation](https://docs.emdashcms.com/deployment/storage/) for host setup. Rebuild and redeploy the site.

Then [open the optimizer](/_emdash/admin/plugins/rapier-media/jpeg-xl) and remove this guide.

The native page uses the host's React and Kumo components. Its browser entry is separate from the server plugin, as required for [native EmDash admin extensions](https://docs.emdashcms.com/plugins/creating-native-plugins/distributing/). The Registry guide uses EmDash's supported sandbox and Block Kit controls.

## Use the optimizer

Upload through EmDash's **Media** page as usual. **JPEG XL Image Optimizer** shows the measured saving, **Mode**, **Sizes**, and **Recent**. The older-images action starts a saved run using the settings selected when the run starts.

JPEG and PNG conversion uses server jobs when the selected operation fits the host's CPU and memory allowances and its reader supports the source. Server work continues through EmDash's scheduler when the page closes; the scheduler must be running. Jobs that cannot safely run on the host convert in the browser while the optimizer page is open. WebP, AVIF and responsive sizes also use the browser. Closing the page stops browser conversion; already accepted server publication work remains durable.

The integration accepts explicit host allowances in a third argument. For a Worker with a 10 ms CPU allowance:

```js
jxl(emdash, options, {cpuLimitMs: 10})
```

Use the host's configured allowance. An omitted CPU value does not classify a plan as Free; error 1102 alone also does not distinguish CPU from memory exhaustion. Cloudflare memory defaults to its 128 MiB isolate limit. Worker admission reserves runtime headroom: the measured operation peak plus 10% must fit both 96 MB and any smaller configured memory allowance. A job with no certified memory bound is handed to the browser, as is a job whose bound exceeds that allowance. Node does not inherit the Worker limit.

An explicitly configured Free Worker (`cpuLimitMs: 10`) accepts delivery copies from an authenticated media administrator after the browser verifies them. The server checks the JPEG XL container/header and compares its displayed geometry with one bounded 64 KiB JPEG/PNG source-header read. Responsive geometry comes from the captured Sizes settings and the oriented source aspect ratio. It also enforces the byte limit and source-generation, delivery-revision, native media-identity, and settings fences. The browser receipt is recorded as informational assurance; it never authorizes original retirement. This path returns an immediate sidecar or responsive copy, without server pixel verification or a pending verification job. The original stays in place. Paid, Node, and Workers with an unknown allowance still require independent server verification before publication.

The structural source check reads pre-scan JPEG Exif or pre-IDAT PNG eXIf; it does not prove anything about metadata after image data, decoded pixel equality, fidelity, or exact reconstruction. Unsupported or incomplete headers within the fixed cap are refused. Normalized orientation is accepted when the displayed geometry agrees. Structural checks still need measurement on the actual Free host; passing source tests is not a 10 ms CPU measurement.

JPEG retirement is enabled on default Node hosting with no explicit CPU cap, or on Node and Workers with an explicitly configured allowance of at least 30,000 ms. An explicitly capped Node host below that threshold retains its physical JPEG, as do Free Workers and Workers whose CPU allowance is unknown. JPEG XL may still be selected as a delivery copy. Physical retention prevents a later cold original request from requiring reconstruction under a 10 ms limit. Paid archival still requires cold-request CPU measurements for the supported image sizes; a cache hit does not establish that bound.

Native admin work uses approximately 5 seconds per request and scheduled Worker work approximately 25 seconds for the whole site's single work task, reduced for an explicit smaller CPU allowance. The shared core advances in roughly 50 ms units at efforts 1–5 and 200 ms at efforts 6–9. These are cooperative targets; actual request CPU and peak memory require host measurements.

The server run supports **Pause**, **Resume**, and **Cancel**. Pause lets the current image finish and holds the next one. Cancel stops pending work and requests cancellation of the current job; a job already publishing must settle first. Completed copies remain available. Reopening the page reads the saved selection and progress.

**Import from WordPress** uses EmDash to import images and rewrite post URLs. Its JPEG and PNG uploads receive the same server treatment as other uploads, including before the post rewrite finishes. Browser conversion starts after that rewrite succeeds. A failed or canceled rewrite stops the browser queue; it does not undo server copies already created. Media URLs and original image bytes remain available throughout.

## Mode and Sizes

| Mode | Meaning | Control |
| --- | --- | --- |
| **Same look** | Looks like the original, much smaller. | Quality, 1 to 100; 90 suits most photos. |
| **Exact** | Lossless. | No quality control. |
| **Size limit** | Fits under the size limit you set. | A positive size in KB. |

When **Keep original JPEG files** is off on an eligible host, JPEG originals are archived separately using lossless JPEG recompression. Otherwise the uploaded JPEG stays in place. **Same look** and **Size limit** also produce a delivery candidate using the selected goal; **Exact** can use a reversible JPEG XL result directly. Delivery chooses the smallest eligible candidate that satisfies the current selection. An archive or retained JPEG preserves the exact original when the delivery representation misses a size limit; an oversized archive is not selected for delivery. An unmet size target reports a miss and leaves original delivery available.

**Effort** is 1 to 9; higher makes smaller files and takes longer. The default is 7. **Sizes** controls responsive widths. The defaults are 640, 750, 828, 960, 1080, 1280, 1668, 1920, 2048, 2560, 3200 and 3840 pixels. Copies do not upscale the source. A Size limit applies to each responsive copy.

Settings load before work starts. Saves are serialized; a failed change returns to the confirmed value. An invalid Size limit stays a draft and prevents new work until a valid limit is saved or another mode is chosen. Accepted server jobs keep their captured settings. The server independently checks browser results before publication.

## Understand the numbers

| Value | Meaning |
| --- | --- |
| **Original** | Bytes in the original file, including a JPEG reconstructed from its archive. |
| **Delivered** | Bytes in the full-size representation selected for JPEG XL delivery, or original bytes when no eligible copy is selected. |
| **Saved** | The positive difference between Original and Delivered. |
| **Stored** | The physical media family: retained originals or JPEG archives, responsive copies, and ownership and delivery records. |

Savings come from actual file sizes. They do not estimate site traffic or count responsive widths as full-size savings. Eligible JPEG retirement replaces the physical JPEG with its reversible archive. Retained JPEGs and other source formats stay beside their delivery copies. Stored includes retained generations, metadata and temporary reconstruction parts, so it differs from delivered bytes and from the site's complete database or backup usage.

Equal or larger full-size results are not selected for JPEG XL delivery. On an eligible host, a JPEG archive may still be kept to preserve the original exactly. Responsive widths are assessed separately because their dimensions differ.

## Keep original JPEG files

The switch controls physical JPEG custody. On keeps the original JPEG files; off allows lossless JPEG XL archives that reconstruct those files exactly. Other formats always keep their originals. It defaults off on Node and on Workers with the 30,000 ms allowance. Free Workers and Workers with an unknown allowance show it on and disabled.

Turning it on stops new archive admission immediately, settles any in-flight archive writer, preserves selected JPEG XL delivery, and restores archived JPEGs through the same durable bounded machinery used for safe removal. The switch stays at its confirmed off value while restoration is pending and changes to on only after a zero-archive proof. Source changes, interrupted requests and uncertain acknowledgements leave recoverable saved work; they do not permit a blind repeat of a physical write. A blocked transition keeps the integration installed and its original bytes available.

Turning it off starts a saved progressive scan of existing JPEGs. Each image still needs the host's operation admission and a private successful server verification receipt before archival. Unsupported or resource-bound images keep their physical originals and their reason is recorded. The policy survives reopening the page and resumes through the site's single scheduled work task. Existing sidecars, responsive copies and the selected delivery mode remain independent of this setting.

Selected archive delivery is preserved under its original private receipt before its physical JPEG is restored. This uses the existing bounded 8 MiB copy path in a separate advance. A larger selected archive or an unacknowledged copy leaves the setting pending/blocked; it never silently removes the selected representation. CLI uninstall uses its own permanent removal gate, so a switch operation cannot authorize config removal or reopen an uninstall already in progress.

## Original delivery and downloads

In **Recent**, **Download original** returns the exact original file and MIME type. An archived JPEG is reconstructed losslessly. **Use original** selects those original bytes for delivery and hides the picture's active main and width copies. It keeps the media URL and does not discard the archive needed to restore the JPEG.

**Make smaller** starts a fresh conversion using the current settings. It captures the current source generation and delivery revision. Conditional writes prevent an older page, job, or retained copy from undoing a later original-delivery choice.

Negotiation applies to EmDash's `/_emdash/api/media/file/…` URLs and matching same-origin width requests. The browser must explicitly accept JPEG XL without preferring the alternative. Original fallback, thumbnails, and downloads continue through the storage wrapper. Both delivery representations vary on `Accept`; JPEG XL responses require cache revalidation. Direct bucket or CDN URLs bypass this wrapper, so use the EmDash media URLs.

## Remove it

`npx rapier-jxl remove emdash` restores every original file.

Keep the site running with the integration enabled. In its project folder, run:

```sh
npx rapier-jxl remove emdash
```

For a deployed site, pass its HTTPS origin with `--url https://your-site.example` or set `EMDASH_URL`. The command uses `EMDASH_TOKEN` or the matching, unexpired EmDash login and requires `plugins:manage`. The default local URL is `http://localhost:4321`.

Removal closes new JPEG retirement, drains writers, restores every archived JPEG, and verifies the final inventory. Retained JPEGs already have their original bytes. Only a fresh persisted completion proof for that site and backend permits the command to unwrap `jxl(emdash, options)` and its optional third host-allowance argument. Blocked restoration, lost requests, or a changed config leave the integration configured. Repeating the command resumes the same saved operation. After it succeeds, rebuild and redeploy. The command preserves other dependencies, EmDash options and source Wrangler settings.

Do not remove the wrapper by hand before restoration completes. Disabling the native plugin stops conversion and JPEG XL negotiation, but its configured storage wrapper is still needed to return archived originals. EmDash's uninstall hook does not provide a restoration barrier. Removing the separate Registry guide is safe because it owns no image data.

After removal, Node restores the JPEG's mtime; R2 restores exact bytes and MIME with a new lastModified and ETag, so caches revalidate once.

Removal persists the shared restoration driver's checkpoint and immutable parts between requests. A physical replacement is dispatched only after its unique writer identity is durable; an unacknowledged write stays blocked until a matching stored representation proves completion. A cold ordinary JPEG download uses the same restoration driver, but all of that HTTP response still belongs to one invocation. A warm cache does not establish a 10 ms Free-plan bound after eviction.

## Implementation

`media-plugin.mjs` owns permissions, settings and media binding; `library-jobs.mjs` owns the persistent library selection; `job-runner.mjs` calls the shared resumable driver. Browser work lives in `media-admin.mjs`, `admin-work.mjs` and `media-worker.mjs`. Storage ownership, reversible JPEG archives and delivery selection live in `media-storage.mjs` and its storage helpers.

The native integration counts host operations without applying the sandbox's per-plugin quota. Encoder work remains resumable and storage payloads remain bounded. Source generations, delivery revisions, publication identities and durable removal state fence concurrent work. [EmDash documents native and sandbox execution separately](https://docs.emdashcms.com/deployment/plugin-sandbox/).
