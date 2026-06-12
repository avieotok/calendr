# הפעלת התראות אמיתיות (גם כשהאפליקציה סגורה)

המערכת בנויה משני חלקים:
1. **האתר** (GitHub Pages) — הקבצים `index.html`, `sw.js`, `manifest.json`, `icon-192.png`, `icon-512.png`.
2. **שרת התזמון** (Cloudflare Worker) — הקובץ `worker.js`. רץ תמיד ושולח את ההתראות בזמן.

> חשוב: את `worker.js` מדביקים **רק** בתוך Cloudflare. אין צורך להעלות אותו ל‑GitHub.
> את כל שאר הקבצים מעלים ל‑GitHub כרגיל.

---

## חלק א' — העלאת הקבצים ל‑GitHub
העלה לריפו `calendr` את כל הקבצים הבאים (לאותה תיקייה כמו `index.html`):
`index.html`, `sw.js`, `manifest.json`, `icon-192.png`, `icon-512.png`.

---

## חלק ב' — הקמת שרת התזמון ב‑Cloudflare (חינמי, בלי התקנות)

### 1. צור חשבון
היכנס ל‑https://dash.cloudflare.com ופתח חשבון חינמי.

### 2. צור Worker
בתפריט הצד: **Workers & Pages** ← **Create** ← **Create Worker** ← תן שם (למשל `calendar-push`) ← **Deploy**.
לאחר הפריסה תקבל כתובת בסגנון: `https://calendar-push.XXXX.workers.dev` — **שמור אותה**, נשתמש בה בהמשך.

### 3. הדבק את הקוד
לחץ **Edit code**, מחק את התוכן הקיים, הדבק את כל התוכן של `worker.js`, ולחץ **Deploy**.

### 4. צור אחסון (KV)
בתפריט הצד: **Storage & Databases** ← **KV** ← **Create namespace** ← שם: `CAL` ← **Add**.
חזור ל‑Worker שלך ← **Settings** ← **Bindings** ← **Add** ← **KV namespace**:
- Variable name: `CAL`
- KV namespace: בחר את `CAL` שיצרת ← **Deploy**.

### 5. הגדר משתנים וסוד
ב‑Worker ← **Settings** ← **Variables and Secrets** ← הוסף שלושה:

| סוג | שם (Name) | ערך (Value) |
|-----|-----------|-------------|
| Variable | `VAPID_PUBLIC` | `BOcUhkCknXhoxOsfmBagBtTYrfIy6Kp3x0VANlcgswRL5ExYfrMIcnZSvP7RyPWj6DmAee_WKaJ-dyWTQVSJluo` |
| Secret | `VAPID_PRIVATE_JWK` | (השורה המלאה מהמסגרת למטה) |
| Variable | `VAPID_SUBJECT` | `mailto:`+ המייל שלך (למשל `mailto:avi@gmail.com`) |

ערך ה‑`VAPID_PRIVATE_JWK` (להדביק כמו שהוא, שורה אחת):
```
{"kty":"EC","crv":"P-256","d":"EqNyqd-hIssOMtge7Y8qY3ZEkSw6PxxU0EeDiimgqHI","x":"5xSGQKSdeGjE6x-YFqAG1Nit8jLoqnfHRUA2VyCzBEs","y":"5ExYfrMIcnZSvP7RyPWj6DmAee_WKaJ-dyWTQVSJluo","ext":true,"key_ops":["sign"]}
```
לחץ **Deploy** אחרי ההוספה.

### 6. הגדר הרצה כל דקה (Cron)
ב‑Worker ← **Settings** ← **Triggers** ← **Cron Triggers** ← **Add** ← הזן:
```
* * * * *
```
זה גורם לשרת לבדוק תזכורות כל דקה. **Add** / **Deploy**.

---

## חלק ג' — חיבור האתר לשרת
פתח את `index.html`, ובראש קטע ה‑`<script>` החלף את השורה:
```js
const PUSH_WORKER_URL='https://YOUR-WORKER.workers.dev';
```
בכתובת ה‑Worker האמיתית שקיבלת בשלב 2 (בלי `/` בסוף). שמור והעלה מחדש ל‑GitHub.

> המפתח הציבורי `VAPID_PUBLIC` כבר מוטמע ב‑`index.html` — אין צורך לגעת בו.

---

## חלק ד' — הפעלה במכשיר

### באייפון (חובה!)
1. פתח את האתר ב‑**Safari**.
2. כפתור **שיתוף** ← **הוסף למסך הבית**.
3. פתח את האפליקציה **מהאייקון במסך הבית** (לא מ‑Safari).
4. לחץ **🔔 הפעל התראות** ← אשר. תקבל התראת בדיקה.
> נדרש iPhone עם iOS 16.4 ומעלה. התראות Push באייפון עובדות רק מאפליקציה שהותקנה למסך הבית.

### במחשב / אנדרואיד
פתח את האתר, לחץ **🔔 הפעל התראות**, ואשר את הבקשה. (בכרום אפשר גם "התקן אפליקציה" מסרגל הכתובת.)

---

## איך זה עובד ומה המגבלות
- בכל שינוי בתזכורות, האתר שולח את הרשימה לשרת. השרת בודק כל דקה ושולח התראה כשמגיע הזמן (לפי "התראה לפני" שהגדרת).
- ההתראה מגיעה כהתראת מערכת אמיתית — גם כשהדפדפן/האפליקציה ברקע או סגורים, וגם כשהמסך נעול.
- כדי שהשרת יכיר תזכורת, צריך שהאתר ייפתח לפחות פעם אחת אחרי שיצרת/שינית אותה (כדי לסנכרן). מומלץ לפתוח את האפליקציה מדי פעם.
- ההתראה נשלחת רק לתזכורות שיש להן **שעה** מוגדרת.

## בדיקה מהירה
צור תזכורת לעוד 2–3 דקות עם שעה, עם "התראה לפני: בזמן הפגישה", סגור לגמרי את האפליקציה — וההתראה אמורה להופיע בזמן.
