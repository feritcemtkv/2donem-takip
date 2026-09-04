import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';
import { Readable } from 'stream';

const SUPABASE_URL = 'https://miekldpkuclbinclnvvu.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

if (!SUPABASE_SERVICE_ROLE_KEY || !GOOGLE_SERVICE_ACCOUNT_JSON || !GOOGLE_DRIVE_FOLDER_ID) {
  const missing = [];
  if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
  if (!GOOGLE_SERVICE_ACCOUNT_JSON) missing.push('GOOGLE_SERVICE_ACCOUNT_JSON');
  if (!GOOGLE_DRIVE_FOLDER_ID) missing.push('GOOGLE_DRIVE_FOLDER_ID');
  console.error('Eksik veya boş secret(lar): ' + missing.join(', '));
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

function todayStr() { return new Date().toISOString().slice(0, 10); }

// Ham tablo dökümü: her tablonun TÜM satırlarını olduğu gibi alır.
// Bu format Excel'den farklı olarak ID'leri ve ilişkileri koruduğu için
// ileride bir felaket durumunda veriyi Supabase'e geri yüklemek için uygundur.
const TABLES = [
  'classes', 'students', 'homeworks', 'homework_status',
  'quizzes', 'quiz_scores', 'performance_tasks', 'rubrics', 'rubric_scores',
  'deneme_exams', 'deneme_scores', 'counseling_notes',
];

async function fetchAllTables() {
  const dump = {};
  for (const table of TABLES) {
    const { data, error } = await sb.from(table).select('*');
    if (error) throw new Error(table + ': ' + error.message);
    dump[table] = data || [];
    console.log('  ' + table + ': ' + dump[table].length + ' satır');
  }
  return dump;
}

async function uploadToDrive(authClient, folderId, filename, buffer, mimeType) {
  const drive = google.drive({ version: 'v3', auth: authClient });
  const stream = Readable.from(buffer);
  await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType, body: stream },
    fields: 'id',
  });
}

async function main() {
  console.log('Supabase\'den tüm tablolar çekiliyor...');
  const dump = await fetchAllTables();

  const payload = {
    generated_at: new Date().toISOString(),
    ...dump,
  };
  const buf = Buffer.from(JSON.stringify(payload, null, 2), 'utf-8');

  console.log('Google Drive\'a giriş yapılıyor...');
  const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  const authClient = await auth.getClient();

  const filename = 'yedek_veritabani_' + todayStr() + '.json';
  console.log(filename + ' Drive\'a yükleniyor (' + buf.length + ' byte)...');
  await uploadToDrive(authClient, GOOGLE_DRIVE_FOLDER_ID, filename, buf, 'application/json');
  console.log(filename + ' yüklendi. Tüm yedek tamamlandı.');
}

main().catch(err => {
  console.error('Yedekleme başarısız:', err);
  process.exit(1);
});
