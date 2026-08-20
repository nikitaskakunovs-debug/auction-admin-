# «Kā nokļūt» — ссылки на навигацию

Одна кнопка не может вести в «навигатор» вообще: на iPhone по умолчанию Apple
Maps, у части людей стоит Waze, у части Google. Поэтому показываем выбор, а
порядок подстраиваем под платформу.

## Что нужно от точки выдачи

В настройках склада (`app_settings`) хранить не только адрес строкой, а и
координаты — по строке навигаторы иногда уводят на другой конец улицы, а вход у
нас со двора.

```ts
pickupPoint: {
  name: "Izsoli.lv noliktava",
  address: "Krasta iela 68, Rīga, LV-1019",
  lat: 56.9312,          // координаты входа, не центра здания
  lon: 24.1284,
  note: "Ieeja no pagalma, 1. stāvs",
}
```

## Ссылки

```ts
const { lat, lon, address, name } = pickupPoint;
const q = encodeURIComponent(`${name}, ${address}`);

// Waze — универсальная ссылка, сама открывает приложение или веб
const waze = `https://waze.com/ul?ll=${lat},${lon}&navigate=yes`;

// Google Maps — официальный формат Maps URLs
const gmaps = `https://www.google.com/maps/dir/?api=1`
            + `&destination=${lat},${lon}`
            + `&destination_place_id=`      // если знаем place_id — точнее
            + `&travelmode=driving`;

// Apple Maps
const amaps = `https://maps.apple.com/?daddr=${lat},${lon}&q=${q}&dirflg=d`;
```

**Почему по координатам, а не по адресу:** «Krasta iela 68» ведёт к фасаду, а
вход со двора. Координаты входа экономят человеку пять минут и один звонок в
поддержку.

## Порядок кнопок

```ts
const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent)
  || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);

const order = isIOS
  ? ["amaps", "waze", "gmaps"]
  : ["gmaps", "waze", "amaps"];
```

Это единственное место, где смотрим на user-agent. Ничего не скрываем — все три
показываем всегда, меняется только порядок. Скрывать нельзя: на iPhone человек
мог удалить Apple Maps, на Android — поставить Waze.

## Разметка

```html
<a href="{waze}"  target="_blank" rel="noopener">…</a>
<a href="{gmaps}" target="_blank" rel="noopener">…</a>
<a href="{amaps}" target="_blank" rel="noopener">…</a>
<button type="button" data-copy="{address}">Kopēt adresi</button>
```

Обычные `<a href>`, не `window.open` — иначе iOS блокирует переход как попап, и
кнопка не делает ничего.

`rel="noopener"` обязателен: без него открытая страница получает ссылку на наше
окно через `window.opener`.

## «Kopēt adresi»

`navigator.clipboard.writeText(address)` с запасным вариантом через скрытый
`<textarea>` + `document.execCommand("copy")` — `clipboard` доступен только на
HTTPS и в отдельных браузерах может быть запрещён политикой. После копирования —
тост «Adrese nokopēta», иначе непонятно, сработало ли.

## Пакоматы

У пакомата тоже есть координаты — они приходят из справочника
`GET /api/public/shipping/locations`. Поэтому «Kā nokļūt» работает и для строки
«Gaida pakomātā»: те же три ссылки, только координаты из выбранной точки, а не
из настроек склада.
