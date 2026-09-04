
import { createClient } from '@supabase/supabase-js';
import * as XLSX from 'xlsx';
import { google } from 'googleapis';
import { Readable } from 'stream';

const SUPABASE_URL = 'https://miekldpkuclbinclnvvu.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const GOOGLE_SERVICE_ACCOUNT_JSON = process.env.GOOGLE_SERVICE_ACCOUNT_JSON;
const GOOGLE_DRIVE_FOLDER_ID = process.env.GOOGLE_DRIVE_FOLDER_ID;

if (!SUPABASE_SERVICE_ROLE_KEY || !GOOGLE_SERVICE_ACCOUNT_JSON || !GOOGLE_DRIVE_FOLDER_ID) {
  console.error('Eksik secret var: SUPABASE_SERVICE_ROLE_KEY, GOOGLE_SERVICE_ACCOUNT_JSON, GOOGLE_DRIVE_FOLDER_ID hepsi gerekli.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY);

function isGrade12(name) { return /12/.test(name || ''); }
function isGrade11(name) { return /11/.test(name || ''); }
function todayStr() { return new Date().toISOString().slice(0, 10); }

function autoWidth(rows) {
  if (!rows || !rows.length) return [];
  const keys = Object.keys(rows[0]);
  return keys.map(k => {
    let maxLen = k.length;
    rows.forEach(r => { const len = String(r[k] ?? '').length; if (len > maxLen) maxLen = len; });
    return { wch: Math.min(Math.max(maxLen + 2, 8), 42) };
  });
}
function addSheet(wb, rows, sheetName) {
  if (!rows || !rows.length) return;
  const ws = XLSX.utils.json_to_sheet(rows);
  ws['!cols'] = autoWidth(rows);
  XLSX.utils.book_append_sheet(wb, ws, sheetName.slice(0, 31));
}
function rubricTotal(rubrics, rubricScores, sid, level) {
  const crit = rubrics[level] || [];
  const scores = (rubricScores[sid] || {})[level] || {};
  let sum = 0, max = 0, any = false;
  crit.forEach((c, i) => { max += c.max; if (scores[i] != null) { sum += scores[i]; any = true; } });
  return { sum, max, grade: any ? Math.round(sum / max * 100) : null };
}
function hwPct(homeworks, hwStatus, sid, today) {
  const assigned = homeworks.filter(h => h.check_date && h.check_date <= today);
  if (!assigned.length) return 0;
  const st = hwStatus[sid] || {};
  let done = 0; assigned.forEach(h => { if (st[h.slot_no]) done++; });
  return Math.round((done / assigned.length) * 100);
}

function buildClassWorkbook(cls) {
  const g12 = isGrade12(cls.name);
  const showTytAyt = g12 || isGrade11(cls.name);
  const sorted = [...cls.students].sort((a, b) => {
    const na = parseInt(a.no), nb = parseInt(b.no);
    const va = isNaN(na) ? Infinity : na, vb = isNaN(nb) ? Infinity : nb;
    if (va !== vb) return va - vb;
    return (a.name || '').localeCompare(b.name || '', 'tr');
  });
  const today = todayStr();
  const wb = XLSX.utils.book_new();

  addSheet(wb, sorted.map(s => ({
    'No': s.no || '', 'Ad Soyad': s.name,
    'Ödev %': hwPct(cls.homeworks, cls.hwStatus, s.id, today),
    'Okulda Yok': s.absent ? 'Evet' : 'Hayır',
    'Öğretmen Notu': s.teacher_note || '',
  })), 'Öğrenciler');

  const hwRows = [];
  sorted.forEach(s => {
    cls.homeworks.forEach(h => {
      const done = !!(cls.hwStatus[s.id] || {})[h.slot_no];
      const checked = h.check_date && h.check_date <= today;
      hwRows.push({
        'No': s.no || '', 'Ad Soyad': s.name,
        'Ödev': h.topic || ('Ödev #' + h.slot_no),
        'Veriliş Tarihi': h.hw_date || '', 'Kontrol Tarihi': h.check_date || '',
        'Durum': !checked ? 'Kontrol tarihi gelmedi' : (done ? 'Yaptı' : 'Yapmadı'),
      });
    });
  });
  addSheet(wb, hwRows, 'Ödevler');

  if (!g12 && cls.quizzes.length) {
    const rows = [];
    sorted.forEach(s => {
      cls.quizzes.forEach(q => {
        const v = (cls.quizScores[s.id] || {})[q.slot_no] || {};
        rows.push({ 'No': s.no || '', 'Ad Soyad': s.name, 'KDS': q.label, 'Doğru': v.dogru ?? '', 'Yanlış': v.yanlis ?? '', 'Boş': v.bos ?? '' });
      });
    });
    addSheet(wb, rows, 'KDS');
  }

  if (!g12 && cls.perfTasks.length) {
    const rows = [];
    sorted.forEach(s => {
      cls.perfTasks.forEach(t => {
        const total = rubricTotal(cls.rubrics, cls.rubricScores, s.id, t.label);
        rows.push({ 'No': s.no || '', 'Ad Soyad': s.name, 'Performans Ödevi': t.label, 'Puan': total.sum, 'Tam Puan': total.max, 'Not': total.grade ?? '' });
      });
    });
    addSheet(wb, rows, 'Performans');
  }

  if (showTytAyt) {
    for (const type of ['tyt', 'ayt']) {
      const exams = type === 'tyt' ? cls.tytExams : cls.aytExams;
      if (!exams.length) continue;
      const rows = [];
      sorted.forEach(s => {
        exams.forEach(ex => {
          const scores = (cls.denemeScoresByExam[ex.id] || {})[s.id] || {};
          (ex.subjects || []).forEach(subj => {
            const v = scores[subj] || {};
            rows.push({ 'No': s.no || '', 'Ad Soyad': s.name, 'Sınav': ex.label, 'Ders': subj, 'Doğru': v.dogru ?? '', 'Yanlış': v.yanlis ?? '', 'Boş': v.bos ?? '' });
          });
        });
      });
      addSheet(wb, rows, type === 'tyt' ? 'TYT' : 'AYT');
    }
  }

  if (g12) {
    const rows = [];
    sorted.forEach(s => {
      (cls.counselingNotes[s.id] || []).forEach(n => {
        rows.push({ 'No': s.no || '', 'Ad Soyad': s.name, 'Tarih': n.note_date || '', 'Not': n.content || '' });
      });
    });
    addSheet(wb, rows, 'Danışmanlık');
  }

  return wb;
}

async function fetchAllClassData() {
  const { data: classes, error: classErr } = await sb.from('classes').select('*').order('sort_order');
  if (classErr) throw new Error('classes: ' + classErr.message);

  const result = [];
  for (const classObj of (classes || [])) {
    const classId = classObj.id;
    const { data: students } = await sb.from('students').select('*').eq('class_id', classId).order('sort_order');
    const { data: homeworks } = await sb.from('homeworks').select('*').eq('class_id', classId).order('slot_no');
    const { data: quizzes } = await sb.from('quizzes').select('*').eq('class_id', classId).order('slot_no');
    const { data: perfTasks } = await sb.from('performance_tasks').select('*').eq('class_id', classId).order('slot_no');
    const { data: denemeExams } = await sb.from('deneme_exams').select('*').eq('class_id', classId).order('slot_no');
    const ids = (students || []).map(s => s.id);

    let hwStatusRows = [], rubricScoreRows = [], quizScoreRows = [], denemeScoreRows = [], counselingNoteRows = [];
    if (ids.length) {
      hwStatusRows = (await sb.from('homework_status').select('*').in('student_id', ids)).data || [];
      rubricScoreRows = (await sb.from('rubric_scores').select('*').in('student_id', ids)).data || [];
      quizScoreRows = (await sb.from('quiz_scores').select('*').in('student_id', ids)).data || [];
      counselingNoteRows = (await sb.from('counseling_notes').select('*').in('student_id', ids)).data || [];
    }
    const examIds = (denemeExams || []).map(e => e.id);
    if (examIds.length) {
      denemeScoreRows = (await sb.from('deneme_scores').select('*').in('exam_id', examIds)).data || [];
    }
    const { data: rubricRows } = await sb.from('rubrics').select('*').eq('class_id', classId);

    const hwStatus = {};
    for (const row of hwStatusRows) { hwStatus[row.student_id] = hwStatus[row.student_id] || {}; hwStatus[row.student_id][row.slot_no] = row.done; }
    const rubricScores = {};
    for (const row of rubricScoreRows) { rubricScores[row.student_id] = rubricScores[row.student_id] || {}; rubricScores[row.student_id][row.level] = rubricScores[row.student_id][row.level] || {}; rubricScores[row.student_id][row.level][row.criteria_index] = row.score; }
    const rubrics = {};
    for (const row of (rubricRows || [])) { rubrics[row.level] = row.criteria; }
    const quizScores = {};
    for (const row of quizScoreRows) { quizScores[row.student_id] = quizScores[row.student_id] || {}; quizScores[row.student_id][row.slot_no] = { dogru: row.dogru, yanlis: row.yanlis, bos: row.bos }; }
    const denemeScoresByExam = {};
    for (const row of denemeScoreRows) {
      denemeScoresByExam[row.exam_id] = denemeScoresByExam[row.exam_id] || {};
      denemeScoresByExam[row.exam_id][row.student_id] = denemeScoresByExam[row.exam_id][row.student_id] || {};
      denemeScoresByExam[row.exam_id][row.student_id][row.subject] = { dogru: row.dogru, yanlis: row.yanlis, bos: row.bos };
    }
    const counselingNotes = {};
    for (const row of counselingNoteRows) { counselingNotes[row.student_id] = counselingNotes[row.student_id] || []; counselingNotes[row.student_id].push(row); }

    result.push({
      id: classId, name: classObj.name,
      students: students || [], homeworks: homeworks || [], hwStatus,
      quizzes: quizzes || [], quizScores,
      perfTasks: perfTasks || [], rubrics, rubricScores,
      tytExams: (denemeExams || []).filter(e => e.exam_type === 'tyt'),
      aytExams: (denemeExams || []).filter(e => e.exam_type === 'ayt'),
      denemeScoresByExam, counselingNotes,
    });
  }
  return result;
}

async function uploadToDrive(authClient, folderId, filename, buffer) {
  const drive = google.drive({ version: 'v3', auth: authClient });
  const stream = Readable.from(buffer);
  await drive.files.create({
    requestBody: { name: filename, parents: [folderId] },
    media: { mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', body: stream },
    fields: 'id',
  });
}

async function main() {
  console.log('Supabase\'den veriler çekiliyor...');
  const classes = await fetchAllClassData();
  console.log(classes.length + ' sınıf bulundu.');

  const creds = JSON.parse(GOOGLE_SERVICE_ACCOUNT_JSON);
  const auth = new google.auth.GoogleAuth({
    credentials: creds,
    scopes: ['https://www.googleapis.com/auth/drive.file'],
  });
  const authClient = await auth.getClient();

  const today = todayStr();
  for (const cls of classes) {
    if (!cls.students.length) { console.log(cls.name + ': öğrenci yok, atlandı.'); continue; }
    const wb = buildClassWorkbook(cls);
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
    const safeName = (cls.name || 'sinif').replace(/[\\/:*?"<>|]/g, '_');
    const filename = safeName + '_yedek_' + today + '.xlsx';
    console.log(filename + ' Drive\'a yükleniyor...');
    await uploadToDrive(authClient, GOOGLE_DRIVE_FOLDER_ID, filename, buf);
    console.log(filename + ' yüklendi.');
  }
  console.log('Tüm yedekler tamamlandı.');
}

main().catch(err => {
  console.error('Yedekleme başarısız:', err);
  process.exit(1);
});
