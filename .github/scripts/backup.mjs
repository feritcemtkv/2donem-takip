import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';
import { Readable } from 'stream';

const SUPABASE_URL = 'https://miekldpkuclbinclnvvu.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
const GOOGLE_REFRESH_TOKEN = (process.env.GOOGLE_REFRESH_TOKEN || '').trim();
const GOOGLE_DRIVE_FOLDER_ID = (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();

const required = {
  SUPABASE_SERVICE_ROLE_KEY, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
  GOOGLE_REFRESH_TOKEN, GOOGLE_DRIVE_FOLDER_ID,
};
const missing = Object.entries(required).filter(([, v]) => !v).map(([k]) => k);
if (missing.length) {
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

async function main() {
  console.log('Supabase\'den tüm tablolar çekiliyor...');
  const dump = await fetchAllTables();

  const payload = {
    generated_at: new Date().toISOString(),
    ...dump,
  };
  const buf = Buffer.from(JSON.stringify(payload, null, 2), 'utf-8');

  console.log('Google\'a (OAuth) giriş yapılıyor...');
  const oauth2Client = new google.auth.OAuth2(GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET);
  oauth2Client.setCredentials({ refresh_token: GOOGLE_REFRESH_TOKEN });
  const drive = google.drive({ version: 'v3', auth: oauth2Client });

  console.log('Klasöre erişim test ediliyor...');
  try {
    const folderCheck = await drive.files.get({
      fileId: GOOGLE_DRIVE_FOLDER_ID,
      fields: 'id, name, mimeType',
    });
    console.log('  Klasör bulundu: "' + folderCheck.data.name + '"');
  } catch (folderErr) {
    console.error('  Klasöre erişilemedi! GOOGLE_DRIVE_FOLDER_ID değerinin doğru olduğundan ve bu klasörün, yetkilendirme yaptığın Google hesabının kendi Drive\'ında olduğundan emin ol.');
    throw folderErr;
  }

  const filename = 'yedek_veritabani_' + todayStr() + '.json';
  console.log(filename + ' Drive\'a yükleniyor (' + buf.length + ' byte)...');
  const stream = Readable.from(buf);
  await drive.files.create({
    requestBody: { name: filename, parents: [GOOGLE_DRIVE_FOLDER_ID] },
    media: { mimeType: 'application/json', body: stream },
    fields: 'id',
  });
  console.log(filename + ' yüklendi. Tüm yedek tamamlandı.');
}

main().catch(err => {
  console.error('Yedekleme başarısız:', err);
  process.exit(1);
});
