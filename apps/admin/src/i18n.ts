import { useSyncExternalStore } from "react";

/**
 * Admin/warehouse i18n — Latvian first (the team's language), Russian and
 * English alongside. Deliberately tiny: a flat dictionary + localStorage
 * persistence. The warehouse shell and login are fully translated; the
 * full-admin screens fall back to English keys until they get their pass.
 */

export type Lang = "lv" | "ru" | "en";
export const LANGS: Lang[] = ["lv", "ru", "en"];

const STORAGE_KEY = "adminLang";

let current: Lang = (() => {
  try {
    const v = localStorage.getItem(STORAGE_KEY);
    return v === "lv" || v === "ru" || v === "en" ? v : "lv";
  } catch {
    return "lv";
  }
})();

const listeners = new Set<() => void>();

export function setLang(l: Lang): void {
  current = l;
  try {
    localStorage.setItem(STORAGE_KEY, l);
  } catch {
    /* private mode — non-fatal */
  }
  listeners.forEach((fn) => fn());
}

export function getLang(): Lang {
  return current;
}

export function useLang(): Lang {
  return useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
}

type Entry = { lv: string; ru: string; en: string };

const D = {
  // ── Login ────────────────────────────────────────────────────────────────
  "login.subtitle": { lv: "Operāciju panelis · LV EE LT", ru: "Панель управления · LV EE LT", en: "Operations panel · LV EE LT" },
  "login.email": { lv: "e-pasts@uznemums.lv", ru: "почта@компания.lv", en: "email@company.com" },
  "login.password": { lv: "Parole", ru: "Пароль", en: "Password" },
  "login.continue": { lv: "Turpināt", ru: "Продолжить", en: "Continue" },
  "login.signingIn": { lv: "Ienāk…", ru: "Вход…", en: "Signing in…" },
  "login.forgot": { lv: "Aizmirsāt paroli?", ru: "Забыли пароль?", en: "Forgot password?" },
  "login.invalid": { lv: "Nepareizs e-pasts vai parole.", ru: "Неверная почта или пароль.", en: "Invalid email or password." },
  "login.tooMany": { lv: "Pārāk daudz mēģinājumu — mēģiniet vēlāk.", ru: "Слишком много попыток — попробуйте позже.", en: "Too many attempts — try again later." },
  "login.totpTitle": { lv: "Divu faktoru kods", ru: "Код двухфакторной защиты", en: "Two-factor code" },
  "login.totpSub": { lv: "Ievadiet 6 ciparu kodu no autentifikatora lietotnes.", ru: "Введите 6-значный код из приложения-аутентификатора.", en: "Enter the 6-digit code from your authenticator app." },
  "login.trustDevice": { lv: "Uzticēties šai pārlūkprogrammai 30 dienas", ru: "Доверять этому браузеру 30 дней", en: "Trust this browser for 30 days" },
  "login.verify": { lv: "Pārbaudīt", ru: "Проверить", en: "Verify" },
  "login.verifying": { lv: "Pārbauda…", ru: "Проверка…", en: "Verifying…" },
  "login.badCode": { lv: "Nepareizs kods. Ievadiet aktuālo 6 ciparu kodu (vai atkopšanas kodu).", ru: "Неверный код. Введите текущий 6-значный код (или код восстановления).", en: "Incorrect code. Enter the current 6-digit code (or a recovery code)." },
  "login.enrollTitle": { lv: "Iestatīt divu faktoru aizsardzību", ru: "Настройка двухфакторной защиты", en: "Set up two-factor" },
  "login.enrollSub": { lv: "Šim kontam nepieciešams autentifikators. Pievienojiet atslēgu un ievadiet kodu.", ru: "Для этого аккаунта нужен аутентификатор. Добавьте ключ и введите код.", en: "This account requires an authenticator. Add the key below, then enter the code it shows." },
  "login.secretKey": { lv: "Slepenā atslēga (manuālai ievadei)", ru: "Секретный ключ (для ручного ввода)", en: "Secret key (manual entry)" },
  "login.codeFromApp": { lv: "Kods no lietotnes", ru: "Код из приложения", en: "Code from app" },
  "login.enable": { lv: "Ieslēgt divu faktoru", ru: "Включить двухфакторную", en: "Enable two-factor" },
  "login.enabling": { lv: "Ieslēdz…", ru: "Включение…", en: "Enabling…" },
  "login.codeMismatch": { lv: "Kods nesakrita. Pārbaudiet autentifikatoru un mēģiniet vēlreiz.", ru: "Код не совпал. Проверьте аутентификатор и попробуйте ещё раз.", en: "That code didn't match. Check your authenticator and try again." },
  "login.recoveryTitle": { lv: "Saglabājiet atkopšanas kodus", ru: "Сохраните коды восстановления", en: "Save your recovery codes" },
  "login.recoverySub": { lv: "Glabājiet drošā vietā. Katrs kods der vienu reizi, ja pazaudējat autentifikatoru.", ru: "Храните в надёжном месте. Каждый код работает один раз, если потеряете аутентификатор.", en: "Store these somewhere safe. Each code works once if you lose your authenticator." },
  "login.recoverySaved": { lv: "Esmu saglabājis — turpināt", ru: "Я сохранил — продолжить", en: "I've saved them — continue" },
  "login.forgotTitle": { lv: "Paroles atjaunošana", ru: "Восстановление пароля", en: "Reset password" },
  "login.forgotSub": { lv: "Ievadiet konta e-pastu — nosūtīsim atjaunošanas saiti.", ru: "Введите почту аккаунта — отправим ссылку для восстановления.", en: "Enter your account email — we'll send a reset link." },
  "login.sendLink": { lv: "Nosūtīt saiti", ru: "Отправить ссылку", en: "Send reset link" },
  "login.sending": { lv: "Sūta…", ru: "Отправка…", en: "Sending…" },
  "login.backToSignIn": { lv: "Atpakaļ uz pieteikšanos", ru: "Назад ко входу", en: "Back to sign in" },
  "login.sentTitle": { lv: "Pārbaudiet e-pastu", ru: "Проверьте почту", en: "Check your email" },
  "login.sentSub": { lv: "Ja adresei ir konts, saite ir ceļā. Tā derīga 30 minūtes.", ru: "Если у адреса есть аккаунт, ссылка уже в пути. Она действует 30 минут.", en: "If that address has an account, a reset link is on its way. It stays valid for 30 minutes." },
  "login.resetTitle": { lv: "Izvēlieties jaunu paroli", ru: "Выберите новый пароль", en: "Choose a new password" },
  "login.resetSub": { lv: "Iepriekšējās sesijas tiks izrakstītas visur.", ru: "Прежние сессии будут завершены везде.", en: "Your previous sessions will be signed out everywhere." },
  "login.newPassword": { lv: "Jaunā parole", ru: "Новый пароль", en: "New password" },
  "login.setPassword": { lv: "Saglabāt jauno paroli", ru: "Сохранить новый пароль", en: "Set new password" },
  "login.saving": { lv: "Saglabā…", ru: "Сохранение…", en: "Saving…" },
  "login.weakPassword": { lv: "Parole pārāk vāja — vismaz 10 zīmes, ne vārds vai e-pasts.", ru: "Пароль слишком слабый — минимум 10 знаков, не имя и не почта.", en: "That password is too weak — use 10+ characters, not based on your name or email." },
  "login.badResetLink": { lv: "Saite nederīga vai beigusies. Pieprasiet jaunu.", ru: "Ссылка недействительна или устарела. Запросите новую.", en: "This reset link is invalid or has expired. Request a new one." },
  "login.doneTitle": { lv: "Parole nomainīta", ru: "Пароль изменён", en: "Password updated" },
  "login.doneSub": { lv: "Ienāciet ar jauno paroli. Autentifikatora kods joprojām darbojas.", ru: "Войдите с новым паролем. Код аутентификатора по-прежнему нужен.", en: "Sign in with your new password. Your authenticator code still applies." },
  "login.goToSignIn": { lv: "Uz pieteikšanos", ru: "Ко входу", en: "Go to sign in" },
  "login.error": { lv: "Kaut kas nogāja greizi — mēģiniet vēlreiz.", ru: "Что-то пошло не так — попробуйте ещё раз.", en: "Something went wrong — try again." },

  // ── Warehouse shell ──────────────────────────────────────────────────────
  "wh.title": { lv: "Noliktava", ru: "Склад", en: "Warehouse" },
  "wh.scanLookup": { lv: "Skenēt / meklēt preci", ru: "Сканировать / найти товар", en: "Scan / look up item" },
  "wh.receive": { lv: "Pieņemt piegādi", ru: "Принять поставку", en: "Receive delivery" },
  "wh.putaway": { lv: "Novietot plauktā (vispirms skenēt)", ru: "Разместить (сначала скан)", en: "Putaway (scan first)" },
  "wh.pickQueue": { lv: "Komplektēšanas rinda", ru: "Очередь сборки", en: "Pick queue" },
  "wh.fullAdmin": { lv: "Pilnais panelis →", ru: "Полная панель →", en: "Full admin →" },
  "wh.signOut": { lv: "Iziet", ru: "Выйти", en: "Sign out" },
  "wh.scannersHint": { lv: "📷 Kameras skeneris darbojas jebkurā telefonā. Bluetooth/USB skeneri strādā katrā ievades laukā.", ru: "📷 Сканер камерой работает на любом телефоне. Bluetooth/USB-сканеры работают в каждом поле ввода.", en: "📷 Camera scanning works on any phone. Bluetooth/USB scanners work in every scan box too." },
  "wh.scan": { lv: "Skenēt", ru: "Скан", en: "Scan" },
  "wh.scanCamera": { lv: "📷 Skenēt ar kameru", ru: "📷 Сканировать камерой", en: "📷 Scan with camera" },
  "wh.scanOrType": { lv: "…vai skenējiet ar skeneri / ierakstiet SKU", ru: "…или сканером / введите SKU", en: "…or scan with a hardware scanner / type the SKU" },
  "wh.lookUp": { lv: "Meklēt", ru: "Найти", en: "Look up" },
  "wh.aimItem": { lv: "Notēmējiet uz preces etiķeti", ru: "Наведите на этикетку товара", en: "Aim at the item label" },
  "wh.aimShelf": { lv: "Notēmējiet uz plaukta QR kodu", ru: "Наведите на QR-код полки", en: "Aim at the shelf's bin QR" },
  "wh.close": { lv: "Aizvērt", ru: "Закрыть", en: "Close" },
  "wh.cameraBlocked": { lv: "Kamera bloķēta. Atļaujiet kameru šai vietnei pārlūka iestatījumos — vai ierakstiet kodu.", ru: "Камера заблокирована. Разрешите камеру для этого сайта в настройках браузера — или введите код.", en: "Camera access was blocked. Allow the camera for this site in your browser settings — or close this and type the code." },
  "wh.cameraTip": { lv: "iPhone: lai neprasa katru reizi — Safari adreses joslā “aA” → Vietnes iestatījumi → Kamera → Atļaut.", ru: "iPhone: чтобы не спрашивал каждый раз — в Safari «aA» в адресной строке → Настройки сайта → Камера → Разрешить.", en: "iPhone: to stop the repeated prompt — tap “aA” in Safari's address bar → Website Settings → Camera → Allow." },
  "wh.noMatch": { lv: "Nekas neatbilst šim kodam", ru: "Ничего не найдено по этому коду", en: "Nothing matches that code" },
  "wh.lookupFailed": { lv: "Meklēšana neizdevās", ru: "Поиск не удался", en: "Lookup failed" },
  "wh.nowPickBin": { lv: "Tagad izvēlieties plauktu zemāk", ru: "Теперь выберите полку ниже", en: "Now pick the bin below" },
  "wh.bin": { lv: "Plaukts", ru: "Полка", en: "Bin" },
  "wh.delivery": { lv: "Piegāde", ru: "Поставка", en: "Delivery" },
  "wh.photos": { lv: "Foto", ru: "Фото", en: "Photos" },
  "wh.noPhotos": { lv: "nav foto", ru: "нет фото", en: "no photos" },
  "wh.addPhotos": { lv: "📷 Pievienot foto", ru: "📷 Добавить фото", en: "📷 Add photos" },
  "wh.photoAdded": { lv: "Foto pievienots", ru: "Фото добавлено", en: "Photo added" },
  "wh.photosAdded": { lv: "foto pievienoti", ru: "фото добавлено", en: "photos added" },
  "wh.uploadFailed": { lv: "Augšupielāde neizdevās", ru: "Загрузка не удалась", en: "Upload failed" },
  "wh.allPhotos": { lv: "Visi foto", ru: "Все фото", en: "All photos" },
  "wh.setCover": { lv: "Galvenais foto", ru: "Сделать обложкой", en: "Make cover" },
  "wh.coverSet": { lv: "Galvenais foto iestatīts", ru: "Обложка установлена", en: "Cover photo set" },
  "wh.deletePhoto": { lv: "Dzēst foto", ru: "Удалить фото", en: "Delete photo" },
  "wh.photoDeleted": { lv: "Foto dzēsts", ru: "Фото удалено", en: "Photo deleted" },
  "wh.confirmDeletePhoto": { lv: "Dzēst šo foto? To nevar atsaukt.", ru: "Удалить это фото? Это нельзя отменить.", en: "Delete this photo? This cannot be undone." },
  "wh.grade": { lv: "🏷️ Novērtēt stāvokli", ru: "🏷️ Оценить состояние", en: "🏷️ Grade condition" },
  "wh.condition": { lv: "Stāvoklis", ru: "Состояние", en: "Condition" },
  "wh.notes": { lv: "Piezīmes", ru: "Заметки", en: "Notes" },
  "wh.notesRequired": { lv: "Piezīmes (obligātas)", ru: "Заметки (обязательно)", en: "Notes (required)" },
  "wh.saveGrade": { lv: "Saglabāt novērtējumu", ru: "Сохранить оценку", en: "Save grade" },
  "wh.gradeSaved": { lv: "Novērtējums saglabāts", ru: "Оценка сохранена", en: "Grade saved" },
  "wh.saveFailed": { lv: "Saglabāšana neizdevās", ru: "Сохранение не удалось", en: "Save failed" },
  "wh.cancel": { lv: "Atcelt", ru: "Отмена", en: "Cancel" },
  "wh.putawayMove": { lv: "🗄️ Novietot / pārvietot", ru: "🗄️ Разместить / переместить", en: "🗄️ Putaway / move bin" },
  "wh.scanShelf": { lv: "📷 Skenēt plaukta etiķeti", ru: "📷 Сканировать этикетку полки", en: "📷 Scan the shelf label" },
  "wh.filterBins": { lv: "Filtrēt plauktus… (FRONT-A1)", ru: "Фильтр полок… (FRONT-A1)", en: "Filter bins… (FRONT-A1)" },
  "wh.clearBin": { lv: "Noņemt no plaukta", ru: "Убрать с полки", en: "Clear bin" },
  "wh.binAssigned": { lv: "Plaukts piešķirts", ru: "Полка назначена", en: "Bin assigned" },
  "wh.binCleared": { lv: "Plaukts noņemts", ru: "Полка очищена", en: "Bin cleared" },
  "wh.putawayFailed": { lv: "Novietošana neizdevās", ru: "Размещение не удалось", en: "Putaway failed" },
  "wh.notABin": { lv: "Tas nav plaukta kods — notēmējiet uz plaukta QR", ru: "Это не код полки — наведите на QR полки", en: "That's not a bin label — aim at the shelf's QR" },
  "wh.printLabel": { lv: "🖨️ Drukāt etiķeti", ru: "🖨️ Печать этикетки", en: "🖨️ Print label" },
  "wh.scanNext": { lv: "Skenēt nākamo →", ru: "Сканировать следующий →", en: "Scan next →" },
  "wh.history": { lv: "Vēsture — kurš ko darīja", ru: "История — кто что делал", en: "History — who did what" },
  "wh.historyEmpty": { lv: "Vēl nav ierakstu", ru: "Записей пока нет", en: "No records yet" },
  "wh.openDeliveries": { lv: "Atvērtās piegādes — pieskarieties, lai pieņemtu", ru: "Открытые поставки — нажмите, чтобы принять", en: "Open deliveries — tap one to receive into it" },
  "wh.noDeliveries": { lv: "Nav atvērtu piegāžu. Izveidojiet panelī → Receiving.", ru: "Нет открытых поставок. Создайте в панели → Receiving.", en: "No open deliveries. Create one in the admin → Receiving." },
  "wh.thisSession": { lv: "šajā sesijā", ru: "за эту сессию", en: "this session" },
  "wh.last": { lv: "pēdējais", ru: "последний", en: "last" },
  "wh.itemTitle": { lv: "Nosaukums", ru: "Название", en: "Title" },
  "wh.titlePlaceholder": { lv: "Bosch GSR 18V urbjmašīna, kastē", ru: "Дрель Bosch GSR 18V, в коробке", en: "Bosch GSR 18V drill, boxed" },
  "wh.condNotes": { lv: "Stāvokļa piezīmes", ru: "Заметки о состоянии", en: "Condition notes" },
  "wh.condNotesRequired": { lv: "Stāvokļa piezīmes (obligātas)", ru: "Заметки о состоянии (обязательно)", en: "Condition notes (required)" },
  "wh.received": { lv: "pieņemts", ru: "принят", en: "received" },
  "wh.receiveFailed": { lv: "Pieņemšana neizdevās", ru: "Приём не удался", en: "Receive failed" },
  "wh.receivePhotos": { lv: "Pieņemt → pievienot foto", ru: "Принять → добавить фото", en: "Receive → add photos" },
  "wh.receiveNext": { lv: "Pieņemt → nākamā vienība", ru: "Принять → следующая единица", en: "Receive → next unit" },
  "wh.queueEmpty": { lv: "Rinda tukša — nav gaidošu klientu.", ru: "Очередь пуста — нет ожидающих клиентов.", en: "Queue is empty — no checked-in customers waiting." },
  "wh.items1": { lv: "prece", ru: "товар", en: "item" },
  "wh.itemsN": { lv: "preces", ru: "товаров", en: "items" },
  "wh.ticket": { lv: "Talons", ru: "Талон", en: "Ticket" },
  "wh.claim": { lv: "Pārņemt un sākt komplektēt", ru: "Взять и начать сборку", en: "Claim & start picking" },
  "wh.claimed": { lv: "Talons pārņemts — sāciet komplektēt", ru: "Талон взят — начинайте сборку", en: "Ticket claimed — start picking" },
  "wh.picked": { lv: "✓ Paņemts", ru: "✓ Взято", en: "✓ Picked" },
  "wh.missing": { lv: "Trūkst", ru: "Нет", en: "Missing" },
  "wh.damaged": { lv: "Bojāts", ru: "Повреждён", en: "Damaged" },
  "wh.toCounter": { lv: "🚚 Uz leti (izsniegšana)", ru: "🚚 К стойке (выдача)", en: "🚚 To counter (delivering)" },
  "wh.onBoard": { lv: "Uz IZSNIEGŠANAS tablo — nesiet uz leti", ru: "На табло ВЫДАЧИ — несите к стойке", en: "On the NOW DELIVERING board — bring it to the counter" },
  "wh.pickupCode": { lv: "Klienta 6 ciparu saņemšanas kods", ru: "6-значный код клиента", en: "Client's 6-digit pickup code" },
  "wh.completeHandover": { lv: "Pabeigt izsniegšanu", ru: "Завершить выдачу", en: "Complete handover" },
  "wh.handedOver": { lv: "Izsniegts ✓", ru: "Выдано ✓", en: "Handed over ✓" },
  "wh.actionFailed": { lv: "Darbība neizdevās", ru: "Действие не удалось", en: "Action failed" },
  "wh.loading": { lv: "Ielādē…", ru: "Загрузка…", en: "Loading…" },
  "wh.status.waiting": { lv: "gaida", ru: "ожидает", en: "waiting" },
  "wh.status.picking": { lv: "komplektē", ru: "сборка", en: "picking" },
  "wh.status.delivering": { lv: "izsniedz", ru: "выдача", en: "delivering" },
  "wh.status.pending": { lv: "gaida", ru: "ожидает", en: "pending" },
  "wh.status.picked": { lv: "paņemts", ru: "взято", en: "picked" },
  "wh.status.missing": { lv: "trūkst", ru: "нет", en: "missing" },
  "wh.status.damaged": { lv: "bojāts", ru: "повреждён", en: "damaged" },

  // ── Activity verbs (item history) ────────────────────────────────────────
  "act.created": { lv: "izveidoja preci", ru: "создал(а) товар", en: "created the item" },
  "act.received": { lv: "pieņēma piegādē", ru: "принял(а) в поставке", en: "received in delivery" },
  "act.updated": { lv: "laboja datus", ru: "изменил(а) данные", en: "updated details" },
  "act.photos_added": { lv: "pievienoja foto", ru: "добавил(а) фото", en: "added photos" },
  "act.photo_removed": { lv: "dzēsa foto", ru: "удалил(а) фото", en: "removed a photo" },
  "act.photo_cover_set": { lv: "nomainīja galveno foto", ru: "сменил(а) обложку", en: "changed the cover photo" },
  "act.transition": { lv: "mainīja statusu", ru: "сменил(а) статус", en: "changed status" },
  "act.deleted": { lv: "dzēsa preci", ru: "удалил(а) товар", en: "deleted the item" },
  "act.intake": { lv: "reģistrēja saņemšanu", ru: "зарегистрировал(а) приход", en: "logged intake" },
  "act.putaway": { lv: "novietoja plauktā", ru: "разместил(а) на полке", en: "put away to bin" },
  "act.move": { lv: "pārvietoja", ru: "переместил(а)", en: "moved" },
  "act.pick": { lv: "paņēma no plaukta", ru: "взял(а) с полки", en: "picked from bin" },
  "act.restock": { lv: "atgrieza plauktā", ru: "вернул(а) на полку", en: "restocked" },
  "act.handover": { lv: "izsniedza klientam", ru: "выдал(а) клиенту", en: "handed over" },
  "act.adjust": { lv: "koriģēja atrašanās vietu", ru: "скорректировал(а) место", en: "adjusted location" },
} satisfies Record<string, Entry>;

export type TKey = keyof typeof D;

export function t(key: TKey): string {
  return D[key][current];
}

/** Reactive translator — re-renders the component when the language changes. */
export function useT(): { t: (key: TKey) => string; lang: Lang; setLang: (l: Lang) => void } {
  const lang = useLang();
  return { t: (key) => D[key][lang], lang, setLang };
}
