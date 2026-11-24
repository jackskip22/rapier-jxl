<?php
/**
 * Plugin Name: JPEG XL Storage
 * Plugin URI: https://github.com/jackskip22/rapier-jxl
 * Description: Browser-powered JPEG XL conversion and delivery with Keep originals and Space saver storage modes.
 * Version: 8.5.0
 * Requires at least: 6.8
 * Requires PHP: 7.4
 * Author: rapier-jxl contributors
 * License: MIT
 */

if (!defined('ABSPATH')) {
	exit;
}

define('RAPIER_JXL_VERSION', '8.5.0');
define('RAPIER_JXL_OPTION', 'rapier_jxl_mode');

function rapier_jxl_mode() {
	$mode = get_option(RAPIER_JXL_OPTION, 'keep');
	return $mode === 'space_saver' ? 'space_saver' : 'keep';
}

function rapier_jxl_sanitize_mode($value) {
	return $value === 'space_saver' ? 'space_saver' : 'keep';
}

add_filter('upload_mimes', function ($mimes) {
	$mimes['jxl'] = 'image/jxl';
	return $mimes;
});

add_filter('mime_types', function ($mimes) {
	$mimes['jxl'] = 'image/jxl';
	return $mimes;
});

add_action('admin_init', function () {
	register_setting('media', RAPIER_JXL_OPTION, array(
		'type' => 'string',
		'sanitize_callback' => 'rapier_jxl_sanitize_mode',
		'default' => 'keep',
	));

	add_settings_field(
		'rapier_jxl_mode',
		'JPEG XL storage',
		'rapier_jxl_render_setting',
		'media',
		'default'
	);
});

function rapier_jxl_attachment_statuses() {
	return array('inherit', 'private', 'publish', 'draft', 'auto-draft');
}

function rapier_jxl_removed_ids() {
	return get_posts(array(
		'post_type' => 'attachment',
		'post_status' => rapier_jxl_attachment_statuses(),
		'posts_per_page' => -1,
		'orderby' => 'ID',
		'order' => 'ASC',
		'fields' => 'ids',
		'meta_key' => '_rapier_jxl_removed',
		'meta_value' => '1',
	));
}

function rapier_jxl_pending_ids() {
	return get_posts(array(
		'post_type' => 'attachment',
		'post_status' => rapier_jxl_attachment_statuses(),
		'posts_per_page' => 50,
		'orderby' => 'ID',
		'order' => 'ASC',
		'fields' => 'ids',
		'meta_key' => '_rapier_jxl_pending',
		'meta_value' => '1',
	));
}

function rapier_jxl_preparing_ids() {
	return get_posts(array(
		'post_type' => 'attachment',
		'post_status' => rapier_jxl_attachment_statuses(),
		'posts_per_page' => 50,
		'orderby' => 'ID',
		'order' => 'ASC',
		'fields' => 'ids',
		'meta_key' => '_rapier_jxl_new',
	));
}

function rapier_jxl_render_setting() {
	$mode = rapier_jxl_mode();
	$removed_count = count(rapier_jxl_removed_ids());
	$show_restore = $removed_count > 0;
	?>
	<fieldset id="rapier-jxl-settings">
		<legend class="screen-reader-text"><span>JPEG XL storage</span></legend>
		<p>
			<label>
				<input type="radio" name="<?php echo esc_attr(RAPIER_JXL_OPTION); ?>" value="keep" <?php checked($mode, 'keep'); ?> />
				Keep originals
			</label>
		</p>
		<p>
			<label>
				<input type="radio" name="<?php echo esc_attr(RAPIER_JXL_OPTION); ?>" value="space_saver" <?php checked($mode, 'space_saver'); ?> />
				Space saver
			</label>
		</p>
		<p class="description">
			JPEG uploads can always be restored to the original JPEG. PNG and WebP uploads come back as a new JPEG or PNG.
		</p>
		<div id="rapier-jxl-restore-box" data-removed-count="<?php echo (int) $removed_count; ?>" style="margin-top:12px;<?php echo $show_restore ? '' : 'display:none;'; ?>">
			<p>
				<button type="button" class="button button-secondary" id="rapier-jxl-restore-btn" onclick="try{sessionStorage.setItem('rapier_jxl_restore_requested','1')}catch(e){}">Restore originals</button>
				<span id="rapier-jxl-restore-status" style="margin-left:8px;">
					<?php
					if ($removed_count === 1) {
						echo '1 image is stored as JPEG XL only.';
					} elseif ($removed_count > 1) {
						echo (int) $removed_count . ' images are stored as JPEG XL only.';
					}
					?>
				</span>
			</p>
			<progress id="rapier-jxl-restore-progress" value="0" max="100" style="display:none;width:280px;"></progress>
		</div>
	</fieldset>
	<?php
}

function rapier_jxl_supported_mime($mime) {
	return in_array($mime, array('image/jpeg', 'image/png', 'image/webp'), true);
}

function rapier_jxl_uploads_base() {
	$uploads = wp_get_upload_dir();
	if (!empty($uploads['error']) || empty($uploads['basedir']) || empty($uploads['baseurl'])) {
		return null;
	}
	$real_base = realpath($uploads['basedir']);
	if ($real_base === false) {
		return null;
	}
	return array(
		'basedir' => wp_normalize_path($real_base),
		'baseurl' => untrailingslashit($uploads['baseurl']),
	);
}

function rapier_jxl_attachment_dir($post_id, $meta = null) {
	$uploads = rapier_jxl_uploads_base();
	if (!$uploads) {
		return null;
	}
	if (!is_array($meta)) {
		$meta = wp_get_attachment_metadata($post_id);
	}
	$rel_file = '';
	if (is_array($meta) && !empty($meta['rapier_jxl']['subdir_file'])) {
		$rel_file = $meta['rapier_jxl']['subdir_file'];
	} elseif (is_array($meta) && !empty($meta['file'])) {
		$rel_file = $meta['file'];
	} else {
		$rel_file = (string) get_post_meta($post_id, '_wp_attached_file', true);
	}
	$rel_file = ltrim(wp_normalize_path($rel_file), '/');
	if ($rel_file === '' || strpos($rel_file, '..') !== false) {
		return null;
	}
	$subdir = dirname($rel_file);
	if ($subdir === '.' || $subdir === '') {
		$subdir = '';
	}
	$dir_path = $subdir !== '' ? $uploads['basedir'] . '/' . $subdir : $uploads['basedir'];
	$real_dir = realpath($dir_path);
	if ($real_dir === false) {
		return null;
	}
	$norm_dir = wp_normalize_path($real_dir);
	if ($norm_dir !== $uploads['basedir'] && strpos($norm_dir, $uploads['basedir'] . '/') !== 0) {
		return null;
	}
	$dir_url = $subdir !== '' ? $uploads['baseurl'] . '/' . $subdir : $uploads['baseurl'];
	return array(
		'basedir' => $uploads['basedir'],
		'dir' => $norm_dir,
		'subdir' => $subdir,
		'url' => $dir_url,
	);
}

function rapier_jxl_safe_filename($name) {
	if (!is_string($name) || $name === '') {
		return '';
	}
	if (strpos($name, '/') !== false || strpos($name, '\\') !== false || strpos($name, '..') !== false || strpos($name, "\0") !== false) {
		return '';
	}
	$clean = sanitize_file_name($name);
	if ($clean === '' || $clean[0] === '.' || $clean !== $name) {
		return '';
	}
	return $clean;
}

function rapier_jxl_valid_jxl_bytes($bytes, $max_bytes) {
	if (!is_string($bytes)) {
		return false;
	}
	$len = strlen($bytes);
	if ($len < 8 || $len > $max_bytes) {
		return false;
	}
	if (substr($bytes, 0, 2) === "\xFF\x0A") {
		return true;
	}
	if ($len >= 20 && substr($bytes, 0, 12) === "\x00\x00\x00\x0CJXL \x0D\x0A\x87\x0A") {
		return true;
	}
	return false;
}

function rapier_jxl_valid_raster_bytes($bytes, $max_bytes) {
	if (!is_string($bytes)) {
		return null;
	}
	$len = strlen($bytes);
	if ($len < 24 || $len > $max_bytes) {
		return null;
	}
	$is_jpg = substr($bytes, 0, 3) === "\xFF\xD8\xFF";
	$is_png = substr($bytes, 0, 8) === "\x89PNG\x0D\x0A\x1A\x0A";
	if (!$is_jpg && !$is_png) {
		return null;
	}
	$info = @getimagesizefromstring($bytes);
	if (!is_array($info) || empty($info[0]) || empty($info[1]) || empty($info['mime'])) {
		return null;
	}
	$width = (int) $info[0];
	$height = (int) $info[1];
	if ($is_jpg && $info['mime'] !== 'image/jpeg') {
		return null;
	}
	if ($is_png && $info['mime'] !== 'image/png') {
		return null;
	}
	if (function_exists('imagecreatefromstring')) {
		$im = @imagecreatefromstring($bytes);
		if ($im === false) {
			return null;
		}
		$decoded_w = imagesx($im);
		$decoded_h = imagesy($im);
		imagedestroy($im);
		if ($decoded_w !== $width || $decoded_h !== $height || $decoded_w <= 0 || $decoded_h <= 0) {
			return null;
		}
	}
	return array(
		'width' => $width,
		'height' => $height,
		'mime' => $info['mime'],
	);
}

function rapier_jxl_build_state($post_id, $metadata, $queued_mode = null) {
	$mime = get_post_mime_type($post_id);
	if (!rapier_jxl_supported_mime($mime) || !is_array($metadata) || empty($metadata['file'])) {
		return null;
	}
	$loc = rapier_jxl_attachment_dir($post_id, $metadata);
	if (!$loc) {
		return null;
	}
	$items = array();
	$seen_files = array();

	$add_item = function ($key, $file, $width, $height, $item_mime) use (&$items, &$seen_files, $loc) {
		$clean = rapier_jxl_safe_filename(basename((string) $file));
		if ($clean === '') {
			return;
		}
		if (isset($seen_files[$clean])) {
			$items[$seen_files[$clean]]['aliases'][] = $key;
			return;
		}
		$full_path = $loc['dir'] . '/' . $clean;
		if (!is_file($full_path)) {
			return;
		}
		if (!$width || !$height) {
			$dims = @getimagesize($full_path);
			if (is_array($dims)) {
				$width = (int) $dims[0];
				$height = (int) $dims[1];
				if (empty($item_mime) && !empty($dims['mime'])) {
					$item_mime = $dims['mime'];
				}
			}
		}
		$seen_files[$clean] = $key;
		$items[$key] = array(
			'key' => $key,
			'aliases' => array(),
			'file' => $clean,
			'jxl' => $clean . '.jxl',
			'mime' => $item_mime,
			'width' => (int) $width,
			'height' => (int) $height,
			'bytes' => (int) filesize($full_path),
			'sha256' => hash_file('sha256', $full_path),
			'verified' => false,
		);
	};

	if (!empty($metadata['original_image'])) {
		$add_item('original', $metadata['original_image'], 0, 0, $mime);
	}
	$add_item(
		'full',
		basename($metadata['file']),
		isset($metadata['width']) ? (int) $metadata['width'] : 0,
		isset($metadata['height']) ? (int) $metadata['height'] : 0,
		$mime
	);

	if (!empty($metadata['sizes']) && is_array($metadata['sizes'])) {
		foreach ($metadata['sizes'] as $size_name => $size_info) {
			if (empty($size_info['file'])) {
				continue;
			}
			$size_mime = !empty($size_info['mime-type']) ? $size_info['mime-type'] : $mime;
			if (!rapier_jxl_supported_mime($size_mime)) {
				continue;
			}
			$add_item(
				(string) $size_name,
				$size_info['file'],
				isset($size_info['width']) ? (int) $size_info['width'] : 0,
				isset($size_info['height']) ? (int) $size_info['height'] : 0,
				$size_mime
			);
		}
	}

	if (empty($items['full'])) {
		return null;
	}

	$fallback_key = 'full';
	if (isset($items['large'])) {
		$fallback_key = 'large';
	} else {
		foreach ($items as $k => $it) {
			if (in_array('large', $it['aliases'], true)) {
				$fallback_key = $k;
				break;
			}
		}
	}

	$resolved_mode = ($queued_mode === 'space_saver' || $queued_mode === 'keep') ? $queued_mode : rapier_jxl_mode();

	return array(
		'version' => RAPIER_JXL_VERSION,
		'queued_mode' => $resolved_mode,
		'complete' => false,
		'original_mime' => $mime,
		'subdir_file' => $metadata['file'],
		'original_meta_sizes' => isset($metadata['sizes']) && is_array($metadata['sizes']) ? $metadata['sizes'] : array(),
		'original_image' => isset($metadata['original_image']) ? $metadata['original_image'] : '',
		'full_width' => (int) $items['full']['width'],
		'full_height' => (int) $items['full']['height'],
		'fallback_key' => $fallback_key,
		'fallback_file' => '',
		'fallback_mime' => '',
		'fallback_width' => 0,
		'fallback_height' => 0,
		'fallback_sha256' => '',
		'fallback_verified' => false,
		'removed' => false,
		'items' => $items,
	);
}

add_action('add_attachment', function ($post_id) {
	$mime = get_post_mime_type($post_id);
	if (rapier_jxl_supported_mime($mime)) {
		update_post_meta($post_id, '_rapier_jxl_new', (string) time());
		update_post_meta($post_id, '_rapier_jxl_queued_mode', rapier_jxl_mode());
	}
});

add_filter('wp_generate_attachment_metadata', function ($metadata, $post_id, $context = 'create') {
	if (!empty($GLOBALS['rapier_jxl_internal_write'])) {
		return $metadata;
	}
	$new_ts = get_post_meta($post_id, '_rapier_jxl_new', true);
	if ($new_ts === '' || $new_ts === false) {
		return $metadata;
	}
	$queued_mode = get_post_meta($post_id, '_rapier_jxl_queued_mode', true);
	$state = rapier_jxl_build_state($post_id, $metadata, $queued_mode);
	if ($state) {
		$metadata['rapier_jxl'] = $state;
	} else {
		delete_post_meta($post_id, '_rapier_jxl_new');
		delete_post_meta($post_id, '_rapier_jxl_queued_mode');
	}
	return $metadata;
}, 99, 3);

function rapier_jxl_on_attachment_meta_saved($meta_id, $post_id, $meta_key, $meta_value) {
	if ($meta_key !== '_wp_attachment_metadata' || !empty($GLOBALS['rapier_jxl_internal_write'])) {
		return;
	}
	$meta = is_array($meta_value) ? $meta_value : maybe_unserialize($meta_value);
	if (is_array($meta) && !empty($meta['rapier_jxl']) && is_array($meta['rapier_jxl']) && empty($meta['rapier_jxl']['complete'])) {
		update_post_meta($post_id, '_rapier_jxl_pending', '1');
		delete_post_meta($post_id, '_rapier_jxl_new');
	}
}
add_action('added_post_meta', 'rapier_jxl_on_attachment_meta_saved', 10, 4);
add_action('updated_post_meta', 'rapier_jxl_on_attachment_meta_saved', 10, 4);

add_filter('wp_update_attachment_metadata', function ($metadata, $post_id) {
	if (!empty($GLOBALS['rapier_jxl_internal_write']) || !is_array($metadata)) {
		return $metadata;
	}
	if (empty($metadata['rapier_jxl']) || !is_array($metadata['rapier_jxl'])) {
		return $metadata;
	}
	$prev = $metadata['rapier_jxl'];
	if (!empty($prev['removed'])) {
		return $metadata;
	}
	$current_full = !empty($metadata['file']) ? basename($metadata['file']) : '';
	$recorded_full = isset($prev['items']['full']['file']) ? $prev['items']['full']['file'] : '';
	if ($current_full !== '' && $recorded_full !== '' && $current_full !== $recorded_full) {
		$loc = rapier_jxl_attachment_dir($post_id, $metadata);
		if ($loc && !empty($prev['items'])) {
			foreach ($prev['items'] as $old_item) {
				if (!empty($old_item['jxl'])) {
					$jxl_path = $loc['dir'] . '/' . rapier_jxl_safe_filename($old_item['jxl']);
					if (is_file($jxl_path)) {
						wp_delete_file($jxl_path);
					}
				}
			}
		}
		$next_mode = rapier_jxl_mode();
		$next_state = rapier_jxl_build_state($post_id, $metadata, $next_mode);
		if ($next_state) {
			$metadata['rapier_jxl'] = $next_state;
			update_post_meta($post_id, '_rapier_jxl_queued_mode', $next_mode);
			update_post_meta($post_id, '_rapier_jxl_pending', '1');
		}
	}
	return $metadata;
}, 99, 2);

add_action('delete_attachment', function ($post_id) {
	$meta = wp_get_attachment_metadata($post_id);
	$loc = rapier_jxl_attachment_dir($post_id, $meta);
	if (!$loc || !is_array($meta) || empty($meta['rapier_jxl']['items'])) {
		return;
	}
	$state = $meta['rapier_jxl'];
	$to_delete = array();
	foreach ($state['items'] as $item) {
		if (!empty($item['jxl'])) {
			$to_delete[] = $item['jxl'];
		}
		if (!empty($item['file'])) {
			$to_delete[] = $item['file'];
			$to_delete[] = $item['file'] . '.jxl';
		}
	}
	if (!empty($state['fallback_file'])) {
		$to_delete[] = $state['fallback_file'];
		$to_delete[] = $state['fallback_file'] . '.jxl';
	}
	foreach (array_unique($to_delete) as $fname) {
		$clean = rapier_jxl_safe_filename($fname);
		if ($clean !== '') {
			$target = $loc['dir'] . '/' . $clean;
			if (is_file($target)) {
				wp_delete_file($target);
			}
		}
	}
}, 5);

function rapier_jxl_save_metadata_internal($post_id, $meta) {
	$GLOBALS['rapier_jxl_internal_write'] = true;
	try {
		wp_update_attachment_metadata($post_id, $meta);
	} finally {
		$GLOBALS['rapier_jxl_internal_write'] = false;
	}
}

function rapier_jxl_manifest_for_js($post_id) {
	$meta = wp_get_attachment_metadata($post_id);
	if (!is_array($meta) || empty($meta['rapier_jxl']) || !is_array($meta['rapier_jxl'])) {
		return null;
	}
	$loc = rapier_jxl_attachment_dir($post_id, $meta);
	if (!$loc) {
		return null;
	}
	$state = $meta['rapier_jxl'];
	$items_out = array();
	foreach ($state['items'] as $key => $item) {
		$jxl_name = rapier_jxl_safe_filename($item['jxl']);
		$src_name = rapier_jxl_safe_filename($item['file']);
		$jxl_on_disk = $jxl_name !== '' && is_file($loc['dir'] . '/' . $jxl_name);
		$src_unchanged = false;
		if ($src_name !== '' && is_file($loc['dir'] . '/' . $src_name)) {
			$src_unchanged = hash_equals($item['sha256'], hash_file('sha256', $loc['dir'] . '/' . $src_name));
		}
		$item_verified = !empty($item['verified']) && $jxl_on_disk && (!empty($state['removed']) || $src_unchanged);
		$items_out[] = array(
			'key' => (string) $key,
			'file' => $item['file'],
			'url' => $loc['url'] . '/' . rawurlencode($item['file']),
			'jxlFile' => $item['jxl'],
			'jxlUrl' => $loc['url'] . '/' . rawurlencode($item['jxl']),
			'mime' => $item['mime'],
			'width' => (int) $item['width'],
			'height' => (int) $item['height'],
			'bytes' => (int) $item['bytes'],
			'sha256' => $item['sha256'],
			'kept' => isset($item['kept']) ? $item['kept'] : '',
			'hasAlpha' => !empty($item['has_alpha']),
			'verified' => $item_verified,
		);
	}
	$att_mode = isset($state['queued_mode']) && in_array($state['queued_mode'], array('keep', 'space_saver'), true)
		? $state['queued_mode']
		: rapier_jxl_mode();
	return array(
		'id' => (int) $post_id,
		'title' => get_the_title($post_id),
		'preparing' => false,
		'mode' => $att_mode,
		'originalMime' => $state['original_mime'],
		'fallbackKey' => $state['fallback_key'],
		'fallbackFile' => isset($state['fallback_file']) ? $state['fallback_file'] : '',
		'removed' => !empty($state['removed']),
		'items' => $items_out,
	);
}

function rapier_jxl_can_edit_attachment($post_id, $post = null) {
	if (!$post) {
		$post = get_post($post_id);
	}
	if (!$post || $post->post_type !== 'attachment') {
		return false;
	}
	if (current_user_can('edit_post', $post_id)) {
		return true;
	}
	$uid = get_current_user_id();
	return $uid > 0 && (int) $post->post_author === (int) $uid && current_user_can('upload_files');
}

function rapier_jxl_rest_permission(WP_REST_Request $request) {
	$nonce = $request->get_header('X-WP-Nonce');
	if (!$nonce) {
		$nonce = (string) $request->get_param('_wpnonce');
	}
	if (!$nonce || !wp_verify_nonce($nonce, 'wp_rest')) {
		return new WP_Error('rapier_jxl_nonce', 'Invalid security token.', array('status' => 403));
	}
	if (!current_user_can('upload_files')) {
		return new WP_Error('rapier_jxl_cap', 'Upload permission required.', array('status' => 403));
	}
	$id = (int) $request->get_param('id');
	if ($id > 0) {
		$post = get_post($id);
		if ($post && $post->post_type === 'attachment' && !rapier_jxl_can_edit_attachment($id, $post)) {
			return new WP_Error('rapier_jxl_post_cap', 'Cannot edit this attachment.', array('status' => 403));
		}
	}
	return true;
}

add_action('rest_api_init', function () {
	register_rest_route('rapier-jxl/v1', '/queue', array(
		'methods' => 'GET',
		'permission_callback' => 'rapier_jxl_rest_permission',
		'callback' => function (WP_REST_Request $request) {
			$single_id = (int) $request->get_param('id');
			if ($single_id > 0) {
				$manifest = rapier_jxl_manifest_for_js($single_id);
				if (!$manifest) {
					return new WP_Error('rapier_jxl_not_found', 'Attachment has no JPEG XL record.', array('status' => 404));
				}
				return rest_ensure_response(array(
					'mode' => rapier_jxl_mode(),
					'attachment' => $manifest,
				));
			}

			$pending = array();
			$seen_pending = array();
			$now = time();

			foreach (rapier_jxl_preparing_ids() as $nid) {
				$nid = (int) $nid;
				if (!get_post($nid)) {
					delete_post_meta($nid, '_rapier_jxl_new');
					delete_post_meta($nid, '_rapier_jxl_queued_mode');
					continue;
				}
				$m = rapier_jxl_manifest_for_js($nid);
				if ($m) {
					$raw_meta = wp_get_attachment_metadata($nid);
					if (empty($raw_meta['rapier_jxl']['complete'])) {
						update_post_meta($nid, '_rapier_jxl_pending', '1');
						delete_post_meta($nid, '_rapier_jxl_new');
						$pending[] = $m;
						$seen_pending[$nid] = true;
					} else {
						delete_post_meta($nid, '_rapier_jxl_new');
					}
					continue;
				}
				$started = (int) get_post_meta($nid, '_rapier_jxl_new', true);
				if ($started > 0 && ($now - $started) > 600) {
					delete_post_meta($nid, '_rapier_jxl_new');
					delete_post_meta($nid, '_rapier_jxl_queued_mode');
					continue;
				}
				$qmode = get_post_meta($nid, '_rapier_jxl_queued_mode', true);
				$pending[] = array(
					'id' => $nid,
					'title' => get_the_title($nid),
					'preparing' => true,
					'mode' => ($qmode === 'space_saver' || $qmode === 'keep') ? $qmode : rapier_jxl_mode(),
					'items' => array(),
				);
				$seen_pending[$nid] = true;
			}

			foreach (rapier_jxl_pending_ids() as $pid) {
				$pid = (int) $pid;
				if (isset($seen_pending[$pid])) {
					continue;
				}
				if (!get_post($pid)) {
					delete_post_meta($pid, '_rapier_jxl_pending');
					continue;
				}
				$m = rapier_jxl_manifest_for_js($pid);
				if ($m) {
					$pending[] = $m;
					$seen_pending[$pid] = true;
				} elseif (get_post_meta($pid, '_rapier_jxl_new', true) === '') {
					delete_post_meta($pid, '_rapier_jxl_pending');
				}
			}

			$removed = array();
			foreach (rapier_jxl_removed_ids() as $rid) {
				$m = rapier_jxl_manifest_for_js($rid);
				if ($m && $m['removed']) {
					$removed[] = $m;
				} else {
					delete_post_meta($rid, '_rapier_jxl_removed');
				}
			}

			return rest_ensure_response(array(
				'mode' => rapier_jxl_mode(),
				'pending' => $pending,
				'removed' => $removed,
				'removedCount' => count($removed),
			));
		},
	));

	register_rest_route('rapier-jxl/v1', '/file', array(
		'methods' => 'POST',
		'permission_callback' => 'rapier_jxl_rest_permission',
		'callback' => 'rapier_jxl_handle_file_route',
	));
});

function rapier_jxl_read_uploaded_bytes(WP_REST_Request $request) {
	$files = $request->get_file_params();
	if (empty($files['file']) || !is_array($files['file'])) {
		return null;
	}
	$upload = $files['file'];
	if (!empty($upload['error']) || empty($upload['tmp_name']) || !is_file($upload['tmp_name'])) {
		return null;
	}
	$bytes = file_get_contents($upload['tmp_name']);
	return is_string($bytes) ? $bytes : null;
}

function rapier_jxl_write_atomic($dir, $filename, $bytes) {
	$clean = rapier_jxl_safe_filename($filename);
	if ($clean === '' || !is_string($bytes)) {
		return false;
	}
	$target = $dir . '/' . $clean;
	$tmp = $dir . '/.jxl-tmp-' . wp_generate_password(12, false, false);
	if (file_put_contents($tmp, $bytes, LOCK_EX) !== strlen($bytes)) {
		@unlink($tmp);
		return false;
	}
	if (!@rename($tmp, $target)) {
		@unlink($tmp);
		return false;
	}
	@chmod($target, 0644);
	clearstatcache(true, $target);
	return is_file($target) && filesize($target) === strlen($bytes);
}

function rapier_jxl_replace_post_urls($old_url, $new_url) {
	if ($old_url === '' || $new_url === '' || $old_url === $new_url) {
		return;
	}
	global $wpdb;
	if (!isset($wpdb->posts)) {
		return;
	}
	$like = '%' . $wpdb->esc_like($old_url) . '%';
	$rows = $wpdb->get_results($wpdb->prepare(
		"SELECT ID, post_content FROM {$wpdb->posts} WHERE post_content LIKE %s AND post_type NOT IN ('revision', 'attachment')",
		$like
	));
	if (!is_array($rows)) {
		return;
	}
	foreach ($rows as $row) {
		$updated = str_replace($old_url, $new_url, $row->post_content);
		if ($updated !== $row->post_content) {
			$wpdb->update($wpdb->posts, array('post_content' => $updated), array('ID' => (int) $row->ID));
			clean_post_cache((int) $row->ID);
		}
	}
}

function rapier_jxl_handle_file_route(WP_REST_Request $request) {
	$id = (int) $request->get_param('id');
	$action = (string) $request->get_param('action');
	$meta = wp_get_attachment_metadata($id);
	if ($id <= 0 || !is_array($meta) || empty($meta['rapier_jxl']) || !is_array($meta['rapier_jxl'])) {
		return new WP_Error('rapier_jxl_missing', 'Attachment record not found.', array('status' => 404));
	}
	$loc = rapier_jxl_attachment_dir($id, $meta);
	if (!$loc) {
		return new WP_Error('rapier_jxl_path', 'Invalid upload folder.', array('status' => 400));
	}
	$max_bytes = max((int) wp_max_upload_size(), 64 * 1024 * 1024);
	$state = $meta['rapier_jxl'];

	if ($action === 'abort_pending') {
		delete_post_meta($id, '_rapier_jxl_pending');
		delete_post_meta($id, '_rapier_jxl_new');
		delete_post_meta($id, '_rapier_jxl_queued_mode');
		return rest_ensure_response(array('ok' => true, 'aborted' => true));
	}

	if ($action === 'save_jxl') {
		$key = (string) $request->get_param('key');
		$filename = rapier_jxl_safe_filename((string) $request->get_param('filename'));
		if (!isset($state['items'][$key])) {
			return new WP_Error('rapier_jxl_key', 'Unknown image size key.', array('status' => 400));
		}
		if ($request->get_param('verified') !== '1') {
			return new WP_Error('rapier_jxl_unverified', 'JPEG XL output must be verified before saving.', array('status' => 400));
		}
		$item = $state['items'][$key];
		if ($filename === '' || $filename !== $item['jxl'] || substr($filename, -4) !== '.jxl') {
			return new WP_Error('rapier_jxl_filename', 'Invalid JPEG XL filename.', array('status' => 400));
		}
		$bytes = rapier_jxl_read_uploaded_bytes($request);
		if ($bytes === null || !rapier_jxl_valid_jxl_bytes($bytes, $max_bytes)) {
			return new WP_Error('rapier_jxl_signature', 'Invalid JPEG XL signature or size.', array('status' => 400));
		}
		$source_path = $loc['dir'] . '/' . $item['file'];
		if (!is_file($source_path)) {
			return new WP_Error('rapier_jxl_source_missing', 'Original source file missing.', array('status' => 400));
		}
		$disk_sha = hash_file('sha256', $source_path);
		if (!hash_equals($item['sha256'], $disk_sha)) {
			return new WP_Error('rapier_jxl_source_changed', 'Source file changed during conversion.', array('status' => 409));
		}
		$kept = (string) $request->get_param('kept');
		if (!in_array($kept, array('jpeg-bytes', 'pixels', 'lossy'), true)) {
			return new WP_Error('rapier_jxl_kept', 'Invalid encoding fidelity record.', array('status' => 400));
		}
		if ($item['mime'] === 'image/jpeg') {
			$restored_sha = strtolower((string) $request->get_param('restored_sha256'));
			if ($kept !== 'jpeg-bytes' || !hash_equals($disk_sha, $restored_sha)) {
				return new WP_Error('rapier_jxl_jpeg_mismatch', 'Restored JPEG hash did not match the server file.', array('status' => 400));
			}
		}
		if (!rapier_jxl_write_atomic($loc['dir'], $filename, $bytes)) {
			return new WP_Error('rapier_jxl_write', 'Could not write JPEG XL file.', array('status' => 500));
		}
		$state['items'][$key]['jxl_bytes'] = strlen($bytes);
		$state['items'][$key]['jxl_sha256'] = hash('sha256', $bytes);
		$state['items'][$key]['kept'] = $kept;
		$state['items'][$key]['has_alpha'] = $request->get_param('has_alpha') === '1';
		$state['items'][$key]['verified'] = true;
		$meta['rapier_jxl'] = $state;
		rapier_jxl_save_metadata_internal($id, $meta);

		return rest_ensure_response(array(
			'ok' => true,
			'key' => $key,
			'jxl' => $filename,
			'bytes' => strlen($bytes),
		));
	}

	if ($action === 'finalize') {
		foreach ($state['items'] as $k => $it) {
			$jxl_name = rapier_jxl_safe_filename($it['jxl']);
			$jxl_path = $jxl_name !== '' ? $loc['dir'] . '/' . $jxl_name : '';
			if (empty($it['verified']) || $jxl_path === '' || !is_file($jxl_path)) {
				return new WP_Error('rapier_jxl_incomplete', 'Not all JPEG XL sizes were verified.', array('status' => 400));
			}
			$jxl_disk = @file_get_contents($jxl_path);
			if (!is_string($jxl_disk) || !rapier_jxl_valid_jxl_bytes($jxl_disk, $max_bytes)) {
				return new WP_Error('rapier_jxl_incomplete', 'Verified JPEG XL file is unreadable on disk.', array('status' => 400));
			}
			if (!empty($it['jxl_sha256']) && !hash_equals($it['jxl_sha256'], hash('sha256', $jxl_disk))) {
				return new WP_Error('rapier_jxl_incomplete', 'Verified JPEG XL file hash changed on disk.', array('status' => 400));
			}
		}

		$current_mode = rapier_jxl_mode();
		$queued_mode = isset($state['queued_mode']) && in_array($state['queued_mode'], array('keep', 'space_saver'), true)
			? $state['queued_mode']
			: $current_mode;
		$use_space_saver = ($queued_mode === 'space_saver' && $current_mode === 'space_saver');

		if (!$use_space_saver) {
			$state['complete'] = true;
			$meta['rapier_jxl'] = $state;
			rapier_jxl_save_metadata_internal($id, $meta);
			delete_post_meta($id, '_rapier_jxl_pending');
			delete_post_meta($id, '_rapier_jxl_new');
			delete_post_meta($id, '_rapier_jxl_queued_mode');
			return rest_ensure_response(array(
				'ok' => true,
				'mode' => 'keep',
				'removed' => false,
			));
		}

		$fb_key = $state['fallback_key'];
		if (!isset($state['items'][$fb_key])) {
			return new WP_Error('rapier_jxl_fb_key', 'Fallback image slot not found.', array('status' => 400));
		}
		$fb_item = $state['items'][$fb_key];
		$fallback_file = '';
		$fallback_mime = '';
		$fallback_w = 0;
		$fallback_h = 0;
		$fallback_sha = '';
		$backup_tmp = '';
		$created_new_fallback = '';
		$copied_new_jxl = '';
		$old_fb_jxl_to_remove = '';

		$rollback_fallback = function () use (&$backup_tmp, &$created_new_fallback, &$copied_new_jxl, $loc, $fb_item) {
			if ($copied_new_jxl !== '' && is_file($copied_new_jxl)) {
				@unlink($copied_new_jxl);
			}
			if ($backup_tmp !== '' && is_file($backup_tmp)) {
				@rename($backup_tmp, $loc['dir'] . '/' . $fb_item['file']);
			} elseif ($created_new_fallback !== '' && is_file($created_new_fallback)) {
				@unlink($created_new_fallback);
			}
		};

		if ($state['original_mime'] === 'image/jpeg') {
			$fb_path = $loc['dir'] . '/' . $fb_item['file'];
			$fb_bytes = is_file($fb_path) ? @file_get_contents($fb_path) : false;
			if (!is_string($fb_bytes) || !hash_equals($fb_item['sha256'], hash('sha256', $fb_bytes))) {
				return new WP_Error('rapier_jxl_fb_missing', 'Fallback JPEG is missing on disk.', array('status' => 400));
			}
			$fb_raster = rapier_jxl_valid_raster_bytes($fb_bytes, $max_bytes);
			if (!$fb_raster || $fb_raster['mime'] !== 'image/jpeg') {
				return new WP_Error('rapier_jxl_fb_invalid', 'Fallback JPEG did not decode cleanly.', array('status' => 400));
			}
			$fallback_file = $fb_item['file'];
			$fallback_mime = 'image/jpeg';
			$fallback_w = $fb_raster['width'];
			$fallback_h = $fb_raster['height'];
			$fallback_sha = hash('sha256', $fb_bytes);
		} else {
			$uploaded = rapier_jxl_read_uploaded_bytes($request);
			$raster = $uploaded !== null ? rapier_jxl_valid_raster_bytes($uploaded, $max_bytes) : null;
			if (!$raster) {
				return new WP_Error('rapier_jxl_fb_invalid', 'Valid decodable JPEG or PNG fallback image required.', array('status' => 400));
			}
			$ext = $raster['mime'] === 'image/png' ? 'png' : 'jpg';
			$fb_stem = pathinfo($fb_item['file'], PATHINFO_FILENAME);
			$candidate_name = rapier_jxl_safe_filename($fb_stem . '.' . $ext);
			if ($candidate_name === '') {
				return new WP_Error('rapier_jxl_fb_write', 'Invalid fallback filename.', array('status' => 400));
			}
			$target_fb_path = $loc['dir'] . '/' . $candidate_name;
			if ($candidate_name === $fb_item['file'] && is_file($target_fb_path)) {
				$orig_bytes = @file_get_contents($target_fb_path);
				$backup_tmp = $loc['dir'] . '/.jxl-bak-' . wp_generate_password(12, false, false);
				if (!is_string($orig_bytes) || file_put_contents($backup_tmp, $orig_bytes, LOCK_EX) !== strlen($orig_bytes)) {
					@unlink($backup_tmp);
					return new WP_Error('rapier_jxl_fb_write', 'Could not stage original backup before fallback write.', array('status' => 500));
				}
			} else {
				$created_new_fallback = $target_fb_path;
			}
			if (!rapier_jxl_write_atomic($loc['dir'], $candidate_name, $uploaded)) {
				$rollback_fallback();
				return new WP_Error('rapier_jxl_fb_write', 'Could not save fallback image.', array('status' => 500));
			}
			$disk_fb_bytes = @file_get_contents($target_fb_path);
			$disk_raster = is_string($disk_fb_bytes) ? rapier_jxl_valid_raster_bytes($disk_fb_bytes, $max_bytes) : null;
			if (!$disk_raster) {
				$rollback_fallback();
				return new WP_Error('rapier_jxl_fb_invalid', 'Saved fallback image failed decode verification.', array('status' => 500));
			}

			$desired_fb_jxl = rapier_jxl_safe_filename($candidate_name . '.jxl');
			if ($desired_fb_jxl === '') {
				$rollback_fallback();
				return new WP_Error('rapier_jxl_fb_write', 'Invalid fallback JPEG XL filename.', array('status' => 500));
			}
			if ($desired_fb_jxl !== $fb_item['jxl']) {
				$src_jxl_bytes = @file_get_contents($loc['dir'] . '/' . $fb_item['jxl']);
				if (!is_string($src_jxl_bytes) || !rapier_jxl_write_atomic($loc['dir'], $desired_fb_jxl, $src_jxl_bytes)) {
					$rollback_fallback();
					return new WP_Error('rapier_jxl_fb_write', 'Could not place JPEG XL file beside fallback image.', array('status' => 500));
				}
				$copied_new_jxl = $loc['dir'] . '/' . $desired_fb_jxl;
				$old_fb_jxl_to_remove = $loc['dir'] . '/' . $fb_item['jxl'];
				$state['items'][$fb_key]['jxl'] = $desired_fb_jxl;
			}

			$fallback_file = $candidate_name;
			$fallback_mime = $disk_raster['mime'];
			$fallback_w = $disk_raster['width'];
			$fallback_h = $disk_raster['height'];
			$fallback_sha = hash('sha256', $disk_fb_bytes);
		}

		$will_remove_any = ($state['original_mime'] !== 'image/jpeg') || (count($state['items']) > 1);
		$old_full_url = $loc['url'] . '/' . $state['items']['full']['file'];
		$fallback_url = $loc['url'] . '/' . $fallback_file;
		$rel_fallback = ($loc['subdir'] !== '' ? $loc['subdir'] . '/' : '') . $fallback_file;
		$fb_filesize = (int) filesize($loc['dir'] . '/' . $fallback_file);

		$state['removed'] = $will_remove_any;
		$state['complete'] = true;
		$state['fallback_file'] = $fallback_file;
		$state['fallback_mime'] = $fallback_mime;
		$state['fallback_width'] = $fallback_w;
		$state['fallback_height'] = $fallback_h;
		$state['fallback_sha256'] = $fallback_sha;
		$state['fallback_verified'] = true;

		$meta['file'] = $rel_fallback;
		$meta['width'] = $fallback_w;
		$meta['height'] = $fallback_h;
		$meta['filesize'] = $fb_filesize;
		unset($meta['original_image']);
		$meta['sizes'] = array(
			'large' => array(
				'file' => $fallback_file,
				'width' => $fallback_w,
				'height' => $fallback_h,
				'mime-type' => $fallback_mime,
				'filesize' => $fb_filesize,
			),
		);
		$meta['rapier_jxl'] = $state;

		update_post_meta($id, '_wp_attached_file', $rel_fallback);
		wp_update_post(array(
			'ID' => $id,
			'post_mime_type' => $fallback_mime,
		));
		rapier_jxl_save_metadata_internal($id, $meta);
		if ($will_remove_any) {
			update_post_meta($id, '_rapier_jxl_removed', '1');
		}

		$persisted_meta = wp_get_attachment_metadata($id);
		if (!is_array($persisted_meta) || empty($persisted_meta['rapier_jxl']['complete']) || ($will_remove_any && (empty($persisted_meta['rapier_jxl']['removed']) || get_post_meta($id, '_rapier_jxl_removed', true) !== '1'))) {
			delete_post_meta($id, '_rapier_jxl_removed');
			$rollback_fallback();
			return new WP_Error('rapier_jxl_meta_write', 'Could not record Space saver metadata before removing originals.', array('status' => 500));
		}

		$removed_files = array();
		foreach ($state['items'] as $k => $it) {
			if ($it['file'] === $fallback_file) {
				if ($backup_tmp !== '' && is_file($backup_tmp)) {
					@unlink($backup_tmp);
					$removed_files[] = $it['file'];
				}
				continue;
			}
			$p = $loc['dir'] . '/' . $it['file'];
			if (is_file($p)) {
				wp_delete_file($p);
				$removed_files[] = $it['file'];
			}
		}
		if ($old_fb_jxl_to_remove !== '' && is_file($old_fb_jxl_to_remove)) {
			wp_delete_file($old_fb_jxl_to_remove);
		}

		delete_post_meta($id, '_rapier_jxl_pending');
		delete_post_meta($id, '_rapier_jxl_new');
		delete_post_meta($id, '_rapier_jxl_queued_mode');
		rapier_jxl_replace_post_urls($old_full_url, $fallback_url);

		return rest_ensure_response(array(
			'ok' => true,
			'mode' => 'space_saver',
			'removed' => $will_remove_any,
			'removedFiles' => $removed_files,
			'fallbackFile' => $fallback_file,
		));
	}

	if ($action === 'restore_item') {
		$key = (string) $request->get_param('key');
		if (!isset($state['items'][$key])) {
			return new WP_Error('rapier_jxl_key', 'Unknown image size key.', array('status' => 400));
		}
		$item = $state['items'][$key];
		$bytes = rapier_jxl_read_uploaded_bytes($request);
		$raster = $bytes !== null ? rapier_jxl_valid_raster_bytes($bytes, $max_bytes) : null;
		if (!$raster) {
			return new WP_Error('rapier_jxl_restore_invalid', 'Restored file must be a valid decodable JPEG or PNG.', array('status' => 400));
		}

		if (isset($item['kept']) && $item['kept'] === 'jpeg-bytes') {
			if ($raster['mime'] !== 'image/jpeg' || !hash_equals($item['sha256'], hash('sha256', $bytes))) {
				return new WP_Error('rapier_jxl_restore_hash', 'Restored JPEG did not match the original hash.', array('status' => 400));
			}
			$target_name = $item['file'];
		} else {
			$ext = $raster['mime'] === 'image/png' ? 'png' : 'jpg';
			$stem = pathinfo($item['file'], PATHINFO_FILENAME);
			$target_name = rapier_jxl_safe_filename($stem . '.' . $ext);
		}

		if ($target_name === '' || !rapier_jxl_write_atomic($loc['dir'], $target_name, $bytes)) {
			return new WP_Error('rapier_jxl_restore_write', 'Could not write restored file.', array('status' => 500));
		}

		$state['items'][$key]['restored_file'] = $target_name;
		$state['items'][$key]['restored_mime'] = $raster['mime'];
		$state['items'][$key]['restored_width'] = $raster['width'];
		$state['items'][$key]['restored_height'] = $raster['height'];
		$meta['rapier_jxl'] = $state;
		rapier_jxl_save_metadata_internal($id, $meta);

		return rest_ensure_response(array(
			'ok' => true,
			'key' => $key,
			'file' => $target_name,
			'mime' => $raster['mime'],
			'bytes' => strlen($bytes),
		));
	}

	if ($action === 'finish_restore') {
		foreach ($state['items'] as $k => $it) {
			$rf = isset($it['restored_file']) ? $it['restored_file'] : '';
			if ($rf === '' || !is_file($loc['dir'] . '/' . $rf)) {
				return new WP_Error('rapier_jxl_restore_incomplete', 'Not all image sizes have been restored.', array('status' => 400));
			}
		}

		$old_fallback = isset($state['fallback_file']) ? $state['fallback_file'] : '';
		$restored_names = array();
		foreach ($state['items'] as $k => $it) {
			$rf = $it['restored_file'];
			$restored_names[] = $rf;
			$new_jxl = $rf . '.jxl';
			if ($new_jxl !== $it['jxl'] && is_file($loc['dir'] . '/' . $it['jxl'])) {
				@rename($loc['dir'] . '/' . $it['jxl'], $loc['dir'] . '/' . $new_jxl);
				$state['items'][$k]['jxl'] = $new_jxl;
			}
			$state['items'][$k]['file'] = $rf;
			$state['items'][$k]['mime'] = $it['restored_mime'];
			$state['items'][$k]['width'] = (int) $it['restored_width'];
			$state['items'][$k]['height'] = (int) $it['restored_height'];
			$state['items'][$k]['bytes'] = (int) filesize($loc['dir'] . '/' . $rf);
			$state['items'][$k]['sha256'] = hash_file('sha256', $loc['dir'] . '/' . $rf);
			unset($state['items'][$k]['restored_file'], $state['items'][$k]['restored_mime'], $state['items'][$k]['restored_width'], $state['items'][$k]['restored_height']);
		}

		if ($old_fallback !== '' && !in_array($old_fallback, $restored_names, true)) {
			$fb_path = $loc['dir'] . '/' . rapier_jxl_safe_filename($old_fallback);
			if (is_file($fb_path)) {
				wp_delete_file($fb_path);
			}
		}

		$full_item = $state['items']['full'];
		$rel_full = ($loc['subdir'] !== '' ? $loc['subdir'] . '/' : '') . $full_item['file'];
		$new_sizes = array();
		foreach ($state['items'] as $k => $it) {
			if ($k === 'full' || $k === 'original') {
				continue;
			}
			$entry = array(
				'file' => $it['file'],
				'width' => (int) $it['width'],
				'height' => (int) $it['height'],
				'mime-type' => $it['mime'],
				'filesize' => (int) $it['bytes'],
			);
			$new_sizes[$k] = $entry;
			if (!empty($it['aliases'])) {
				foreach ($it['aliases'] as $alias) {
					if ($alias !== 'full' && $alias !== 'original') {
						$new_sizes[$alias] = $entry;
					}
				}
			}
		}

		$state['removed'] = false;
		$state['queued_mode'] = 'keep';
		$state['subdir_file'] = $rel_full;
		$state['original_mime'] = $full_item['mime'];
		$old_fb_url = $old_fallback !== '' ? $loc['url'] . '/' . $old_fallback : '';
		$new_full_url = $loc['url'] . '/' . $full_item['file'];
		$state['fallback_file'] = '';
		$state['fallback_mime'] = '';
		$state['fallback_sha256'] = '';
		$state['fallback_verified'] = false;

		$meta['file'] = $rel_full;
		$meta['width'] = (int) $full_item['width'];
		$meta['height'] = (int) $full_item['height'];
		$meta['filesize'] = (int) $full_item['bytes'];
		$meta['sizes'] = $new_sizes;
		if (isset($state['items']['original'])) {
			$meta['original_image'] = $state['items']['original']['file'];
		} else {
			unset($meta['original_image']);
		}
		$meta['rapier_jxl'] = $state;

		update_post_meta($id, '_wp_attached_file', $rel_full);
		wp_update_post(array(
			'ID' => $id,
			'post_mime_type' => $full_item['mime'],
		));
		rapier_jxl_save_metadata_internal($id, $meta);
		delete_post_meta($id, '_rapier_jxl_removed');
		if ($old_fb_url !== '') {
			rapier_jxl_replace_post_urls($old_fb_url, $new_full_url);
		}
		if ($request->get_param('switch_to_keep') === '1' && current_user_can('manage_options')) {
			update_option(RAPIER_JXL_OPTION, 'keep');
		}

		return rest_ensure_response(array(
			'ok' => true,
			'restored' => true,
			'file' => $full_item['file'],
			'mime' => $full_item['mime'],
		));
	}

	return new WP_Error('rapier_jxl_action', 'Unknown action.', array('status' => 400));
}

function rapier_jxl_enqueue_admin() {
	if (!current_user_can('upload_files')) {
		return;
	}
	static $enqueued_for = null;
	$scripts = wp_scripts();
	$instance_key = is_object($scripts) ? spl_object_id($scripts) : 0;
	if ($enqueued_for === $instance_key) {
		return;
	}
	$enqueued_for = $instance_key;

	wp_enqueue_script('wp-api-request');
	$rest_root = esc_url_raw(rest_url());
	$nonce = wp_create_nonce('wp_rest');
	$src = plugin_dir_url(__FILE__) . 'admin.js';
	wp_enqueue_script('rapier-jxl-admin', $src, array('wp-api-request'), RAPIER_JXL_VERSION, true);
	wp_localize_script('rapier-jxl-admin', 'rapierJxlAdmin', array(
		'restUrl' => esc_url_raw(rest_url('rapier-jxl/v1')),
		'nonce' => $nonce,
		'mode' => rapier_jxl_mode(),
		'removedCount' => count(rapier_jxl_removed_ids()),
		'mediaSettingsUrl' => esc_url_raw(admin_url('options-media.php#rapier-jxl-settings')),
		'pluginBasename' => plugin_basename(__FILE__),
	));
	$early_boot = sprintf(
		'window.wpApiSettings = window.wpApiSettings || {root: %s, nonce: %s};' .
		'if (!window.wpApiSettings.nonce) { window.wpApiSettings.nonce = %s; }' .
		'(function(){' .
		'if (window.__rapierJxlBooted) return; window.__rapierJxlBooted = true;' .
		'var state = window.__rapierJxlUploadWatch = {active: 0, dirty: false, onActivity: null};' .
		'function notify(){ state.dirty = true; if (typeof state.onActivity === "function") state.onActivity(); }' .
		'function isUploadUrl(u){ return typeof u === "string" && u.indexOf("rapier-jxl/v1") === -1 && (u.indexOf("async-upload.php") !== -1 || u.indexOf("admin-ajax.php") !== -1 || /\/wp\/v2\/media(?:\b|\/)/.test(u)); }' .
		'var origOpen = XMLHttpRequest.prototype.open, origSend = XMLHttpRequest.prototype.send;' .
		'XMLHttpRequest.prototype.open = function(m, u){ this._rjMethod = String(m || "GET").toUpperCase(); this._rjUrl = String(u || ""); return origOpen.apply(this, arguments); };' .
		'XMLHttpRequest.prototype.send = function(body){' .
		'if (this._rjMethod === "POST" && isUploadUrl(this._rjUrl)) {' .
		'var track = this._rjUrl.indexOf("async-upload.php") !== -1 || /\/wp\/v2\/media(?:\b|\/)/.test(this._rjUrl) || (typeof FormData === "function" && body instanceof FormData);' .
		'if (track) { state.active++; notify(); }' .
		'this.addEventListener("loadend", function(){ if (track && state.active > 0) state.active--; notify(); }, {once: true});' .
		'}' .
		'return origSend.apply(this, arguments);' .
		'};' .
		'})();',
		wp_json_encode($rest_root),
		wp_json_encode($nonce),
		wp_json_encode($nonce)
	);
	wp_add_inline_script('wp-api-request', $early_boot, 'after');
}
add_action('admin_enqueue_scripts', 'rapier_jxl_enqueue_admin');
add_action('enqueue_block_editor_assets', 'rapier_jxl_enqueue_admin');

add_filter('script_loader_tag', function ($tag, $handle, $src) {
	if ($handle === 'rapier-jxl-admin' || $handle === 'rapier-jxl-front') {
		return preg_replace_callback('/<script\b([^>]*\bsrc=[^>]+)>/i', function ($m) {
			$attrs = preg_replace('/\s+type=(["\']).*?\1/i', '', $m[1]);
			return '<script type="module"' . $attrs . '>';
		}, $tag, 1);
	}
	return $tag;
}, 10, 3);

add_action('after_plugin_row_' . plugin_basename(__FILE__), function () {
	$count = count(rapier_jxl_removed_ids());
	if ($count <= 0) {
		return;
	}
	$url = admin_url('options-media.php#rapier-jxl-settings');
	echo '<tr class="plugin-update-tr active"><td colspan="4" class="plugin-update colspanchange">';
	echo '<div class="notice inline notice-warning notice-alt"><p>';
	echo esc_html($count === 1 ? '1 image is stored as JPEG XL only.' : $count . ' images are stored as JPEG XL only.') . ' ';
	echo 'Before deactivating this plug-in, open <a href="' . esc_url($url) . '">Settings, Media</a> and click Restore originals.';
	echo '</p></div></td></tr>';
});

function rapier_jxl_same_ratio($w1, $h1, $w2, $h2) {
	if ($w1 <= 0 || $h1 <= 0 || $w2 <= 0 || $h2 <= 0) {
		return true;
	}
	return abs(($w1 / $h1) - ($w2 / $h2)) < 0.025;
}

function rapier_jxl_wrap_img_tag($img_html, $attachment_id) {
	if (strpos($img_html, 'data-jxl-wrapped=') !== false) {
		return $img_html;
	}
	$meta = wp_get_attachment_metadata($attachment_id);
	if (!is_array($meta) || empty($meta['rapier_jxl']['items'])) {
		return $img_html;
	}
	$loc = rapier_jxl_attachment_dir($attachment_id, $meta);
	if (!$loc) {
		return $img_html;
	}
	$state = $meta['rapier_jxl'];

	$target_w = (int) $state['full_width'];
	$target_h = (int) $state['full_height'];
	if (preg_match('/\bwidth=["\'](\d+)["\']/i', $img_html, $wm) && preg_match('/\bheight=["\'](\d+)["\']/i', $img_html, $hm)) {
		$target_w = (int) $wm[1];
		$target_h = (int) $hm[1];
	}

	$by_width = array();
	foreach ($state['items'] as $key => $it) {
		if ($key === 'original' || empty($it['jxl']) || empty($it['width']) || empty($it['height'])) {
			continue;
		}
		if (!is_file($loc['dir'] . '/' . rapier_jxl_safe_filename($it['jxl']))) {
			continue;
		}
		if (!rapier_jxl_same_ratio($it['width'], $it['height'], $target_w, $target_h)) {
			continue;
		}
		$w = (int) $it['width'];
		$by_width[$w] = $loc['url'] . '/' . rawurlencode($it['jxl']) . ' ' . $w . 'w';
	}

	if (empty($by_width)) {
		$full_jxl = isset($state['items']['full']['jxl']) ? $state['items']['full']['jxl'] : '';
		if ($full_jxl === '' || !is_file($loc['dir'] . '/' . rapier_jxl_safe_filename($full_jxl))) {
			return $img_html;
		}
		$jxl_srcset = $loc['url'] . '/' . rawurlencode($full_jxl);
	} else {
		ksort($by_width, SORT_NUMERIC);
		$jxl_srcset = implode(', ', array_values($by_width));
	}

	$sizes_attr = '';
	if (preg_match('/\bsizes=(["\'])(.*?)\1/i', $img_html, $sm)) {
		$sizes_attr = $sm[2];
	} elseif (count($by_width) > 1 && $target_w > 0) {
		$sizes_attr = '(max-width: ' . $target_w . 'px) 100vw, ' . $target_w . 'px';
	}

	$updated_img = $img_html;
	$picture_attrs = 'class="rapier-jxl-picture"';
	if (!empty($state['removed']) && !empty($state['fallback_file'])) {
		$fb_url = $loc['url'] . '/' . rawurlencode($state['fallback_file']);
		$updated_img = preg_replace('/\s+srcset=(["\']).*?\1/i', '', $updated_img);
		$updated_img = preg_replace('/\s+sizes=(["\']).*?\1/i', '', $updated_img);
		if (preg_match('/\bsrc=(["\']).*?\1/i', $updated_img)) {
			$updated_img = preg_replace('/\bsrc=(["\']).*?\1/i', 'src="' . esc_url($fb_url) . '"', $updated_img, 1);
		}
		$is_jpeg = (isset($state['items']['full']['kept']) && $state['items']['full']['kept'] === 'jpeg-bytes') ? '1' : '0';
		$updated_img = preg_replace('/<img\b/i', '<img data-jxl-wrapped="1" data-jxl-space-saver="1" data-jxl-jpeg="' . $is_jpeg . '"', $updated_img, 1);
		$picture_attrs .= ' data-jxl-srcset="' . esc_attr($jxl_srcset) . '"';
		if ($sizes_attr !== '') {
			$picture_attrs .= ' data-jxl-sizes="' . esc_attr($sizes_attr) . '"';
		}
		$GLOBALS['rapier_jxl_needs_front_script'] = true;
	} else {
		$updated_img = preg_replace('/<img\b/i', '<img data-jxl-wrapped="1"', $updated_img, 1);
	}

	$source_tag = '<source type="image/jxl" srcset="' . esc_attr($jxl_srcset) . '"';
	if ($sizes_attr !== '') {
		$source_tag .= ' sizes="' . esc_attr($sizes_attr) . '"';
	}
	$source_tag .= ' />';

	return '<picture ' . $picture_attrs . '>' . $source_tag . $updated_img . '</picture>';
}

function rapier_jxl_find_attachment_by_url($src) {
	if ($src === '') {
		return 0;
	}
	$id = attachment_url_to_postid($src);
	if ($id > 0) {
		return (int) $id;
	}
	$clean_url = preg_replace('/-\d+x\d+(?=\.[a-z0-9]+$)/i', '', $src);
	if ($clean_url !== $src) {
		$id = attachment_url_to_postid($clean_url);
		if ($id > 0) {
			return (int) $id;
		}
	}
	return 0;
}

function rapier_jxl_filter_html_images($content) {
	if (is_admin() || strpos($content, '<img') === false) {
		return $content;
	}
	if (is_feed()) {
		return preg_replace_callback('/<img\b[^>]*>/i', function ($m) {
			$img = $m[0];
			$id = 0;
			if (preg_match('/\bwp-image-(\d+)\b/', $img, $idm)) {
				$id = (int) $idm[1];
			} elseif (preg_match('/\bsrc=["\']([^"\']+)["\']/', $img, $sm)) {
				$id = rapier_jxl_find_attachment_by_url($sm[1]);
			}
			if ($id <= 0) {
				return $img;
			}
			$meta = wp_get_attachment_metadata($id);
			if (!is_array($meta) || empty($meta['rapier_jxl']['removed']) || empty($meta['rapier_jxl']['fallback_file'])) {
				return $img;
			}
			$loc = rapier_jxl_attachment_dir($id, $meta);
			if (!$loc) {
				return $img;
			}
			$fb_url = $loc['url'] . '/' . rawurlencode($meta['rapier_jxl']['fallback_file']);
			$img = preg_replace('/\s+srcset=(["\']).*?\1/i', '', $img);
			$img = preg_replace('/\s+sizes=(["\']).*?\1/i', '', $img);
			return preg_replace('/\bsrc=(["\']).*?\1/i', 'src="' . esc_url($fb_url) . '"', $img, 1);
		}, $content);
	}

	$parts = preg_split('/(<picture\b[\s\S]*?<\/picture>)/i', $content, -1, PREG_SPLIT_DELIM_CAPTURE);
	if (!is_array($parts)) {
		return $content;
	}
	$out = '';
	foreach ($parts as $index => $chunk) {
		if ($index % 2 === 1) {
			$out .= $chunk;
			continue;
		}
		$out .= preg_replace_callback('/<img\b[^>]*>/i', function ($m) {
			$img = $m[0];
			$id = 0;
			if (preg_match('/\bwp-image-(\d+)\b/', $img, $idm)) {
				$id = (int) $idm[1];
			} elseif (preg_match('/\bsrc=["\']([^"\']+)["\']/', $img, $sm)) {
				$id = rapier_jxl_find_attachment_by_url($sm[1]);
			}
			return $id > 0 ? rapier_jxl_wrap_img_tag($img, $id) : $img;
		}, $chunk);
	}
	return $out;
}

add_filter('the_content', 'rapier_jxl_filter_html_images', 20);
add_filter('the_content_feed', 'rapier_jxl_filter_html_images', 20);
add_filter('wp_get_attachment_image', function ($html, $attachment_id) {
	if (is_admin() || is_feed() || strpos($html, '<picture') !== false) {
		return $html;
	}
	return rapier_jxl_wrap_img_tag($html, (int) $attachment_id);
}, 20, 2);
add_filter('post_thumbnail_html', function ($html, $post_id, $post_thumbnail_id) {
	if (is_admin() || is_feed() || !$post_thumbnail_id) {
		return $html;
	}
	if (strpos($html, '<picture') !== false) {
		return $html;
	}
	return rapier_jxl_wrap_img_tag($html, (int) $post_thumbnail_id);
}, 20, 3);

add_action('wp_footer', function () {
	if (!empty($GLOBALS['rapier_jxl_needs_front_script']) || rapier_jxl_mode() === 'space_saver') {
		$src = plugin_dir_url(__FILE__) . 'front.js';
		echo '<script type="module" src="' . esc_url($src) . '"></script>' . "\n";
	}
}, 20);

function rapier_jxl_fallback_url_for_attachment($attachment_id) {
	$meta = wp_get_attachment_metadata($attachment_id);
	if (!is_array($meta)) {
		return '';
	}
	$loc = rapier_jxl_attachment_dir($attachment_id, $meta);
	if ($loc && !empty($meta['rapier_jxl']['removed']) && !empty($meta['rapier_jxl']['fallback_file'])) {
		return $loc['url'] . '/' . rawurlencode($meta['rapier_jxl']['fallback_file']);
	}
	$img = wp_get_attachment_image_src($attachment_id, 'large');
	return is_array($img) && !empty($img[0]) ? $img[0] : '';
}

function rapier_jxl_post_preview_image_url($post_id) {
	$thumb_id = (int) get_post_thumbnail_id($post_id);
	if ($thumb_id > 0) {
		$url = rapier_jxl_fallback_url_for_attachment($thumb_id);
		if ($url !== '') {
			return $url;
		}
	}
	$post = get_post($post_id);
	if ($post && preg_match('/\bwp-image-(\d+)\b/', (string) $post->post_content, $m)) {
		return rapier_jxl_fallback_url_for_attachment((int) $m[1]);
	}
	return '';
}

add_action('wp_head', function () {
	if (!is_singular()) {
		return;
	}
	$post_id = get_queried_object_id();
	if (!$post_id) {
		return;
	}
	$og_url = rapier_jxl_post_preview_image_url($post_id);
	if ($og_url !== '') {
		echo '<meta property="og:image" content="' . esc_url($og_url) . '" />' . "\n";
	}
}, 5);

foreach (array('wpseo_opengraph_image', 'rank_math/opengraph/facebook/image', 'jetpack_open_graph_image_default') as $rapier_jxl_og_hook) {
	add_filter($rapier_jxl_og_hook, function ($url) {
		if (is_singular()) {
			$post_id = get_queried_object_id();
			$fallback = $post_id ? rapier_jxl_post_preview_image_url($post_id) : '';
			if ($fallback !== '') {
				return $fallback;
			}
		}
		return $url;
	}, 20);
}
