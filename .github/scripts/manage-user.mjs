import { createClient } from '@supabase/supabase-js';

const SUPABASE_URL = 'https://miekldpkuclbinclnvvu.supabase.co';
const SUPABASE_SERVICE_ROLE_KEY = (process.env.SUPABASE_SERVICE_ROLE_KEY || '').trim();
const PW_USERNAME = (process.env.PW_USERNAME || '').trim();
const PW_PASSWORD = (process.env.PW_PASSWORD || '').trim();

const missing = [];
if (!SUPABASE_SERVICE_ROLE_KEY) missing.push('SUPABASE_SERVICE_ROLE_KEY');
if (!PW_USERNAME) missing.push('PW_USERNAME');
if (!PW_PASSWORD) missing.push('PW_PASSWORD');
if (missing.length) {
  console.error('Eksik veya boş secret(lar): ' + missing.join(', '));
  process.exit(1);
}
if (PW_PASSWORD.length < 6) {
  console.error('Şifre en az 6 karakter olmalı.');
  process.exit(1);
}

const sb = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

const email = PW_USERNAME.includes('@') ? PW_USERNAME : PW_USERNAME + '@takip.local';

async function main() {
  console.log('Kullanıcı aranıyor: ' + email);
  const { data: userList, error: listErr } = await sb.auth.admin.listUsers();
  if (listErr) throw new Error('Kullanıcı listesi alınamadı: ' + listErr.message);
  const existing = (userList.users || []).find(u => u.email === email);

  if (existing) {
    console.log('Kullanıcı bulundu, şifresi güncelleniyor...');
    const { error: updErr } = await sb.auth.admin.updateUserById(existing.id, { password: PW_PASSWORD });
    if (updErr) throw new Error('Şifre güncellenemedi: ' + updErr.message);
    console.log('✅ "' + PW_USERNAME + '" kullanıcısının şifresi güncellendi.');
  } else {
    console.log('Kullanıcı bulunamadı, yeni hesap oluşturuluyor...');
    const { error: createErr } = await sb.auth.admin.createUser({
      email, password: PW_PASSWORD, email_confirm: true,
    });
    if (createErr) throw new Error('Kullanıcı oluşturulamadı: ' + createErr.message);
    console.log('✅ "' + PW_USERNAME + '" adında yeni kullanıcı oluşturuldu.');
  }
  console.log('Not: Şifre gizlilik için hiçbir zaman bu logda yazdırılmadı.');
}

main().catch(err => {
  console.error('İşlem başarısız:', err.message);
  process.exit(1);
});
