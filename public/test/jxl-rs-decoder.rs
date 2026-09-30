// SPDX-License-Identifier: MIT
// A bounded transport around the upstream decoder, with no image reconstruction of its own.
use std::io::{self, Read, Write};
use jxl::api::{JxlColorEncoding, JxlColorProfile, JxlDecoder, JxlDecoderOptions,
    JxlOutputBuffer, JxlPixelFormat, ProcessingResult};

const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_PIXELS: usize = 24_000_000;

fn complete<T, U>(result: ProcessingResult<T, U>) -> Result<T, String> {
    match result {
        ProcessingResult::Complete { result } => Ok(result),
        ProcessingResult::NeedsMoreInput { .. } => Err("truncated JPEG XL stream".into()),
    }
}

fn decode(bytes: &[u8], width: usize, height: usize) -> Result<Vec<u8>, String> {
    if bytes.is_empty() || bytes.len() > MAX_BYTES || width == 0 || height == 0 ||
        width > 16384 || height > 16384 || width * height > MAX_PIXELS {
        return Err("oracle input exceeds admitted bounds".into());
    }
    let mut options = JxlDecoderOptions::default();
    options.sample_limit = Some(MAX_PIXELS * 4);
    options.premultiply_output = false;
    let mut input = bytes;
    let mut image = complete(JxlDecoder::new(options).process(&mut input, None)
        .map_err(|e| e.to_string())?)?;
    if image.basic_info().size != (width, height) {
        return Err(format!("different dimensions: {:?}", image.basic_info().size));
    }
    image.set_pixel_format(JxlPixelFormat::rgba8(image.basic_info().extra_channels.len()))
        .map_err(|e| e.to_string())?;
    // These encoder inputs are sRGB. Refuse a different profile instead of silently comparing unlike samples.
    if ![false, true].iter().any(|gray| image.output_color_profile().same_color_encoding(
        &JxlColorProfile::Simple(JxlColorEncoding::srgb(*gray)))) {
        return Err("oracle expects nonlinear sRGB output".into());
    }
    let frame = complete(image.process(&mut input, None).map_err(|e| e.to_string())?)?;
    let mut rgba = vec![0; width * height * 4];
    let mut buffers = [JxlOutputBuffer::new(&mut rgba, height, width * 4)];
    let image = complete(frame.process(&mut input, &mut buffers, None).map_err(|e| e.to_string())?)?;
    if image.has_more_frames() { return Err("oracle expects one complete still frame".into()); }
    Ok(rgba)
}

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let args: Vec<String> = std::env::args().collect();
    if args.get(1).map(String::as_str) == Some("--version") {
        println!("rapier-jxl-rs-oracle {} {}{}", env!("CARGO_PKG_VERSION"),
            option_env!("RAPIER_JXL_RS_REVISION").unwrap_or("unrecorded"),
            option_env!("RAPIER_JXL_RS_PATCH").map(|name| format!("+{name}")).unwrap_or_default());
        return Ok(());
    }
    let mut input = io::stdin().lock();
    let mut output = io::stdout().lock();
    if args.get(1).map(String::as_str) == Some("--decode") && args.len() == 4 {
        let mut bytes = Vec::new();
        input.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes)?;
        let rgba = decode(&bytes, args[2].parse()?, args[3].parse()?)?;
        output.write_all(&rgba)?;
        return Ok(());
    }
    if args.len() != 1 { return Err("expected --version, --decode width height, or framed stdin".into()); }
    // The development native decoder's transport: greeting, then length/width/height and RGBA replies.
    output.write_all(&0x314c584au32.to_le_bytes())?;
    let version: Vec<u32> = env!("CARGO_PKG_VERSION").split('.').map(str::parse).collect::<Result<_, _>>()?;
    output.write_all(&(version[0] * 1_000_000 + version[1] * 1_000 + version[2]).to_le_bytes())?;
    output.flush()?;
    loop {
        let mut header = [0; 12];
        match input.read(&mut header[..1])? { 0 => return Ok(()), _ => input.read_exact(&mut header[1..])? }
        let word = |offset| u32::from_le_bytes(header[offset..offset + 4].try_into().unwrap()) as usize;
        let (length, width, height) = (word(0), word(4), word(8));
        if length > MAX_BYTES { return Err("oversized request".into()); }
        let mut bytes = vec![0; length];
        input.read_exact(&mut bytes)?;
        let (status, data) = match decode(&bytes, width, height) {
            Ok(rgba) => (0u32, rgba),
            Err(error) => (1u32, error.into_bytes()),
        };
        for value in [status, width as u32, height as u32, data.len() as u32] {
            output.write_all(&value.to_le_bytes())?;
        }
        output.write_all(&data)?;
        output.flush()?;
    }
}
