import { createClient } from '@supabase/supabase-js';
import { google } from 'googleapis';
import { Readable } from 'stream';

const SUPABASE_URL = 'https://miekldpkuclbinclnvvu.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const TEACHER_USERNAME = (process.env.TEACHER_USERNAME || '').trim();
const GOOGLE_CLIENT_ID = (process.env.GOOGLE_CLIENT_ID || '').trim();
const GOOGLE_CLIENT_SECRET = (process.env.GOOGLE_CLIENT_SECRET || '').trim();
const GOOGLE_REFRESH_TOKEN = (process.env.GOOGLE_REFRESH_TOKEN || '').trim();
const GOOGLE_DRIVE_FOLDER_ID = (process.env.GOOGLE_DRIVE_FOLDER_ID || '').trim();

const required = {
  SUPABASE_SERVICE_ROLE_KEY, TEACHER_USERNAME, GOOGLE_CLIENT_ID, GOOGLE_CLIENT_SECRET,
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

// Sadece BU öğretmenin kendi sınıflarını (owner_id ile) ve onlara bağlı
// öğrenci/ödev/not verilerini çeker — sistemdeki diğer öğretmenlerin
// verilerine dokunmaz.
async function fetchOwnerScopedTables(ownerId) {
  const dump = {};

  const { data: classes, error: classErr } = await sb.from('classes').select('*').eq('owner_id', ownerId);
  if (classErr) throw new Error('classes: ' + classErr.message);
  dump.classes = classes || [];
  console.log('  classes: ' + dump.classes.length + ' satır');
  const classIds = dump.classes.map(c => c.id);

  const byClassIds = async (table) => {
    if (!classIds.length) return [];
    const { data, error } = await sb.from(table).select('*').in('class_id', classIds);
    if (error) throw new Error(table + ': ' + error.message);
    return data || [];
  };
  const byStudentIds = async (table, studentIds) => {
    if (!studentIds.length) return [];
    const { data, error } = await sb.from(table).select('*').in('student_id', studentIds);
    if (error) throw new Error(table + ': ' + error.message);
    return data || [];
  };

  dump.students = await byClassIds('students');
  console.log('  students: ' + dump.students.length + ' satır');
  const studentIds = dump.students.map(s => s.id);

  dump.homeworks = await byClassIds('homeworks');
  console.log('  homeworks: ' + dump.homeworks.length + ' satır');
  dump.homework_status = await byStudentIds('homework_status', studentIds);
  console.log('  homework_status: ' + dump.homework_status.length + ' satır');

  dump.quizzes = await byClassIds('quizzes');
  console.log('  quizzes: ' + dump.quizzes.length + ' satır');
  dump.quiz_scores = await byStudentIds('quiz_scores', studentIds);
  console.log('  quiz_scores: ' + dump.quiz_scores.length + ' satır');

  dump.performance_tasks = await byClassIds('performance_tasks');
  console.log('  performance_tasks: ' + dump.performance_tasks.length + ' satır');
  dump.rubrics = await byClassIds('rubrics');
  console.log('  rubrics: ' + dump.rubrics.length + ' satır');
  dump.rubric_scores = await byStudentIds('rubric_scores', studentIds);
  console.log('  rubric_scores: ' + dump.rubric_scores.length + ' satır');

  dump.deneme_exams = await byClassIds('deneme_exams');
  console.log('  deneme_exams: ' + dump.deneme_exams.length + ' satır');
  const examIds = dump.deneme_exams.map(e => e.id);
  if (examIds.length) {
    const { data, error } = await sb.from('deneme_scores').select('*').in('exam_id', examIds);
    if (error) throw new Error('deneme_scores: ' + error.message);
    dump.deneme_scores = data || [];
  } else {
    dump.deneme_scores = [];
  }
  console.log('  deneme_scores: ' + dump.deneme_scores.length + ' satır');

  dump.counseling_notes = await byStudentIds('counseling_notes', studentIds);
  console.log('  counseling_notes: ' + dump.counseling_notes.length + ' satır');

  return dump;
}

async function main() {
  console.log('Öğretmen hesabı bulunuyor...');
  const email = TEACHER_USERNAME.includes('@') ? TEACHER_USERNAME : TEACHER_USERNAME + '@takip.local';
  const { data: userList, error: userErr } = await sb.auth.admin.listUsers();
  if (userErr) throw new Error('Kullanıcı listesi alınamadı: ' + userErr.message);
  const teacherUser = (userList.users || []).find(u => u.email === email);
  if (!teacherUser) throw new Error('Kullanıcı bulunamadı: ' + email + ' (TEACHER_USERNAME değerini kontrol et)');
  console.log('  Bulundu: ' + teacherUser.email);

  console.log('Supabase\'den bu öğretmenin sınıfları çekiliyor...');
  const dump = await fetchOwnerScopedTables(teacherUser.id);

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
