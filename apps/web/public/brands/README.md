# Brand marks (banks, carriers, payment methods)

Официальные логотипы партнёров. Файлы кладутся сюда как есть — из брендбука,
без перекраски и без изменения пропорций.

Ожидаемые имена (SVG, горизонтальный вариант, прозрачный фон):

  swedbank.svg      Swedbank            https://www.swedbank.com/newsroom/logotype.html
  seb.svg           SEB                 https://designlibrary.sebgroup.com/foundation/digital-design/visual-identity/logotype/
  citadele.svg      Citadele            https://www.cblgroup.com/en/media/images/logo/
  luminor.svg       Luminor             brand guidelines
  revolut.svg       Revolut             press kit
  industra.svg      Industra Bank       press kit
  klix.svg          Klix by Citadele    https://developers.klix.app/static-assets/
  klix-pay-later.svg Klix Pay Later     https://developers.klix.app/static-assets/  (logo_LV.svg)
  inbank.svg        Inbank              press kit
  omniva.svg        Omniva              https://www.omniva.ee/brandbook/logo/
  dpd.svg           DPD                 https://www.dpd.com/pl/en/o-dpd/dpd-brand-center/
  visa.svg          Visa                (из набора Klix: VISA_MC_CtP.svg)
  mastercard.svg    Mastercard          (из набора Klix)

Правила, которые уже заложены в компонент BrandMark:
  * логотип не перекрашивается (никаких fill/currentColor), только масштаб;
  * фиксированная высота: 20px в чипе банка, 24px в строке доставки, 28px в модалке;
  * вокруг логотипа охранное поле — padding не меньше половины высоты знака;
  * alt = название компании, чтобы читалка не молчала.
