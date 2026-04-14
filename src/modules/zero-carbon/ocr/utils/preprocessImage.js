// utils/OCR/preprocessImage.js
// Preprocess an image buffer for better OCR accuracy using sharp.
//
// Optimised for real-world phone-photographed utility bills (KSEB, etc.):
//   1. Auto-rotate from EXIF metadata (fixes upside-down/sideways photos)
//   2. Upscale to minimum 2400px wide (Tesseract accuracy improves at 300+ DPI)
//   3. Greyscale
//   4. Boost contrast with linear adjustment
//   5. Normalize (stretch histogram to full range)
//   6. Threshold (binarize) for crisp black-on-white text
//   7. Strong sharpening to recover edge detail
//   8. Output PNG (Tesseract performs best on PNG, not JPEG)

const sharp = require('sharp');

// Minimum width in pixels to present to Tesseract.
// Phone photos are often 1200-2000px — upscaling to 2400 helps OCR significantly.
const MIN_OCR_WIDTH = 2400;

/**
 * Preprocess an image buffer for OCR.
 *
 * @param {Object} options
 * @param {Buffer} options.buffer   - Raw image buffer from multer or pdf2pic
 * @returns {Promise<Buffer>}       - Processed PNG buffer ready for Tesseract
 */
async function preprocessImage({ buffer }) {
  if (!buffer || !Buffer.isBuffer(buffer)) {
    throw new Error('preprocessImage: buffer is required and must be a Buffer');
  }

  try {
    // Read metadata to determine if upscaling is needed
    const meta = await sharp(buffer).metadata();
    const currentWidth = meta.width || 0;

    // Upscale only when the image is smaller than MIN_OCR_WIDTH.
    // Do NOT downscale large images — that loses detail.
    const resizeOptions = currentWidth > 0 && currentWidth < MIN_OCR_WIDTH
      ? { width: MIN_OCR_WIDTH, kernel: sharp.kernel.lanczos3 }
      : null;

    let pipeline = sharp(buffer)
      // 1. Auto-rotate based on EXIF orientation tag (fixes phone camera rotation)
      .rotate()
      // 2. Convert to greyscale (colour information is irrelevant for bill text)
      .greyscale();

    // 3. Upscale if needed (after greyscale to save memory)
    if (resizeOptions) {
      pipeline = pipeline.resize(resizeOptions);
    }

    const processedBuffer = await pipeline
      // 4. Boost contrast: multiply pixel values by 1.4, shift shadows down
      .linear(1.4, -30)
      // 5. Normalize: stretch histogram to full 0-255 range
      .normalize()
      // 6. Threshold: convert to pure black-and-white (removes grey noise)
      //    Value 140 works well for most printed bills; lower = more black
      .threshold(140)
      // 7. Strong sharpen to recover text edge crispness lost by camera blur
      .sharpen({ sigma: 2.0, m1: 2.0, m2: 3.0 })
      // 8. Output PNG (lossless, no JPEG artefacts around text edges)
      .png()
      .toBuffer();

    return processedBuffer;
  } catch (err) {
    throw new Error(`Image preprocessing failed: ${err.message}`);
  }
}

module.exports = { preprocessImage };
