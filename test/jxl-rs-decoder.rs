// SPDX-License-Identifier: MIT
// A bounded transport around the upstream decoder, with no image reconstruction of its own.
use std::io::{self, Read, Write};
use jxl::api::{Endianness, JxlBitDepth, JxlColorEncoding, JxlColorProfile, JxlDataFormat,
    JxlDecoder, JxlDecoderOptions, JxlOutputBuffer, JxlPixelFormat, JxlPrimaries,
    JxlTransferFunction, JxlWhitePoint, ProcessingResult};

const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_PIXELS: usize = 24_000_000;

fn complete<T, U>(result: ProcessingResult<T, U>) -> Result<T, String> {
    match result {
        ProcessingResult::Complete { result } => Ok(result),
        ProcessingResult::NeedsMoreInput { .. } => Err("truncated JPEG XL stream".into()),
    }
}

#[derive(Clone, Copy, Default)]
struct Output { kind: u8, source: bool, metadata: bool }

fn profile_metadata(profile: &JxlColorProfile) -> Result<(u32, u32, u32, u32), String> {
    let (space, white, primaries, transfer) = match profile {
        JxlColorProfile::Simple(JxlColorEncoding::RgbColorSpace {white_point, primaries, transfer_function, ..}) =>
            (0, white_point, Some(primaries), transfer_function),
        JxlColorProfile::Simple(JxlColorEncoding::GrayscaleColorSpace {white_point, transfer_function, ..}) =>
            (1, white_point, None, transfer_function),
        _ => return Err("oracle requires explicit RGB or grayscale colour metadata".into()),
    };
    let white = match white { JxlWhitePoint::D65 => 1, JxlWhitePoint::E => 10,
        JxlWhitePoint::DCI => 11, JxlWhitePoint::Chromaticity {..} => 2 };
    let primaries = match primaries { Some(JxlPrimaries::SRGB) | None => 1,
        Some(JxlPrimaries::BT2100) => 9, Some(JxlPrimaries::P3) => 11, Some(JxlPrimaries::Chromaticities {..}) => 2 };
    let transfer = match transfer { JxlTransferFunction::BT709 => 1, JxlTransferFunction::Linear => 8,
        JxlTransferFunction::SRGB => 13, JxlTransferFunction::PQ => 16, JxlTransferFunction::DCI => 17,
        JxlTransferFunction::HLG => 18, JxlTransferFunction::Gamma(_) => 0 };
    Ok((space, white, primaries, transfer))
}

fn decode(bytes: &[u8], width: usize, height: usize, output: Output) -> Result<Vec<u8>, String> {
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
    let count = image.basic_info().extra_channels.len();
    let mut format = match output.kind {
        1 => JxlPixelFormat::rgba16(count), 2 => JxlPixelFormat::rgba_f16(count),
        3 => JxlPixelFormat::rgba_f32(count), _ => JxlPixelFormat::rgba8(count),
    };
    let sample_bytes = match output.kind { 3 => 4, 1 | 2 => 2, _ => 1 };
    format.color_data_format = Some(match output.kind {
        1 => JxlDataFormat::U16 {endianness: Endianness::LittleEndian,
            bit_depth: if output.source { image.basic_info().bit_depth.bits_per_sample() as u8 } else { 16 }},
        2 => JxlDataFormat::F16 {endianness: Endianness::LittleEndian},
        3 => JxlDataFormat::F32 {endianness: Endianness::LittleEndian},
        _ => JxlDataFormat::U8 {bit_depth: 8},
    });
    image.set_pixel_format(format)
        .map_err(|e| e.to_string())?;
    // Source mode keeps the embedded colour encoding and alpha association; the legacy path requests sRGB.
    if output.source && !image.output_color_profile().same_color_encoding(image.embedded_color_profile()) {
        return Err("oracle output profile differs from the encoded source".into());
    }
    if !output.source && ![false, true].iter().any(|gray| image.output_color_profile().same_color_encoding(
        &JxlColorProfile::Simple(JxlColorEncoding::srgb(*gray)))) {
        return Err("oracle expects nonlinear sRGB output".into());
    }
    let metadata = if output.metadata {
        let info = image.basic_info();
        let (space, white, primaries, transfer) = profile_metadata(image.embedded_color_profile())?;
        let exp = match info.bit_depth {JxlBitDepth::Float {exponent_bits_per_sample, ..} => exponent_bits_per_sample, _ => 0};
        let json = format!("{{\"bitDepth\":{},\"exponentBits\":{},\"alphaBitDepth\":null,\"alphaExponentBits\":null,\"alphaPremultiplied\":{},\"colorSpace\":{},\"primaries\":{},\"transferFunction\":{},\"whitePoint\":{},\"intensityTarget\":{},\"usesOriginalProfile\":{}}}",
            info.bit_depth.bits_per_sample(), exp, info.extra_channels.iter().any(|c| c.alpha_associated),
            space, primaries, transfer, white, info.tone_mapping.intensity_target, info.uses_original_profile);
        let mut prefix = (json.len() as u32).to_le_bytes().to_vec(); prefix.extend(json.bytes()); prefix
    } else { Vec::new() };
    let frame = complete(image.process(&mut input, None).map_err(|e| e.to_string())?)?;
    // u32 storage guarantees the alignment required by every supported output format.
    let mut storage = vec![0u32; width * height * sample_bytes];
    let rgba = unsafe { std::slice::from_raw_parts_mut(storage.as_mut_ptr().cast::<u8>(), storage.len() * 4) };
    let mut buffers = [JxlOutputBuffer::new(rgba, height, width * 4 * sample_bytes)];
    let image = complete(frame.process(&mut input, &mut buffers, None).map_err(|e| e.to_string())?)?;
    if image.has_more_frames() { return Err("oracle expects one complete still frame".into()); }
    let mut result = metadata; result.extend_from_slice(rgba); Ok(result)
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
    let mut setting = Output::default();
    let mut position = 1;
    while position < args.len() {
        match args[position].as_str() {
            "--uint16" => setting.kind = 1, "--float16" => setting.kind = 2,
            "--float" => setting.kind = 3, "--source" => setting.source = true,
            "--metadata" => setting.metadata = true, _ => break,
        }
        position += 1;
    }
    if args.get(position).map(String::as_str) == Some("--decode") && args.len() == position + 3 {
        let mut bytes = Vec::new();
        input.take((MAX_BYTES + 1) as u64).read_to_end(&mut bytes)?;
        let rgba = decode(&bytes, args[position + 1].parse()?, args[position + 2].parse()?, setting)?;
        output.write_all(&rgba)?;
        return Ok(());
    }
    if args.len() != position { return Err("expected --version, output options, --decode width height, or framed stdin".into()); }
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
        let (status, data) = match decode(&bytes, width, height, setting) {
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
