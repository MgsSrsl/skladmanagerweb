// /api/upload.js
import cloudinary from 'cloudinary';
import Busboy from 'busboy';

cloudinary.v2.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key:    process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
  secure: true
});

export const config = {
  api: { bodyParser: false } // сами парсим multipart
};

export default async function handler(req, res) {
  // CORS (на всякий случай)
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  try {
    const { folder = 'tasks', taskId = '' } = req.query; // можно прокидывать из фронта

    const { file, fields } = await parseMultipart(req); // получим stream и метаданные
    const fname = fields?.name || file?.filename || 'file';
    const isPdf = /\.pdf$/i.test(fname) || (file?.mimeType === 'application/pdf');

    const uploadOpts = {
      folder: taskId ? `${folder}/${taskId}` : folder,
      resource_type: isPdf ? 'raw' : 'auto',
      access_mode: 'public',
      use_filename: true,
      unique_filename: false
    };

    const result = await uploadStream(file.stream, uploadOpts);

    // фиксим ссылку, если Cloudinary вдруг вернул image/upload для PDF
    let url = result.secure_url || result.url || '';
    if (isPdf && /\/image\/upload\//.test(url)) {
      url = url.replace('/image/upload/', '/raw/upload/');
    }

    return res.status(200).json({
      url,
      publicId: result.public_id,
      type: isPdf ? 'pdf' : (result.resource_type || 'raw'),
      name: fname
    });
  } catch (e) {
    console.error('upload error', e);
    return res.status(500).json({ error: e?.message || 'upload failed' });
  }
}

// --- helpers ---
function parseMultipart(req) {
  return new Promise((resolve, reject) => {
    const bb = Busboy({ headers: req.headers });
    const out = { fields: {}, file: null };

    bb.on('file', (_name, stream, info) => {
      out.file = { stream, filename: info.filename, mimeType: info.mimeType };
    });
    bb.on('field', (name, val) => { out.fields[name] = val; });
    bb.on('error', reject);
    bb.on('close', () => resolve(out));
    req.pipe(bb);
  });
}

function uploadStream(readable, options) {
  return new Promise((resolve, reject) => {
    const up = cloudinary.v2.uploader.upload_stream(options, (err, result) => {
      if (err) return reject(err);
      resolve(result);
    });
    readable.pipe(up);
  });
}

