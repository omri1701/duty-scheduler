type Translate = (en: string, he: string) => string;

/** What every error or refusal says to the user, in English and Hebrew (decision
 * 2026-11-01): codes from the client libraries and the checked RPCs, and the RPCs'
 * own sentences, each name what happened and what to do. No raw code ever reaches
 * the screen; tests/messages.test.mjs lists every code and sentence and checks it. */
export function userMessage(raw: string, t: Translate): string {
  const message = raw.replace(/^publication-binding:/, '');
  if (/Service temporarily unavailable|^(TypeError: )?Failed to fetch$|^NetworkError when attempting to fetch resource\.?$/.test(message)) return t('Couldn’t reach the server. Check your connection, then try again.', 'לא ניתן היה להתחבר לשרת. יש לבדוק את החיבור ולנסות שוב.');
  if (/The team data changed\. Refresh|stale revision|Workspace changed/.test(message)) return t('The schedule changed in another tab or by someone else, so it was refreshed. Check it, then try again.', 'הלוח השתנה בכרטיסייה אחרת או על ידי מישהו אחר, ולכן רוענן. כדאי לבדוק ולנסות שוב.');
  // Schedule and calendar rules (validate.ts, generation_validate, the checked RPCs).
  if (/neighbor-conflict|Boundary conflict|Invalid boundary/.test(message)) return t('A locked duty touches the same person’s duty in the next or previous month. Review it in the calendar, or unlock it.', 'תורנות נעולה צמודה לתורנות של אותו אדם בחודש הקודם או הבא. יש לבדוק אותה בלוח או לבטל את הנעילה.');
  if (/lock-changed|Explicitly review locks|Invalid lock review|Missing lock|Lock requires its existing primary/.test(message)) return t('A locked duty changed. Review the locks in the calendar, then try again.', 'תורנות נעולה השתנתה. יש לבדוק את הנעילות בלוח ולנסות שוב.');
  if (/unavailable-primary|Availability conflict/.test(message)) return t('Someone is assigned on a date they marked unavailable. Change that duty, or approve it with a reason.', 'מישהו שובץ בתאריך שסימן שאינו זמין. יש לשנות את התורנות או לאשר אותה עם סיבה.');
  if (/target-exceeded/.test(message)) return t('Someone has more duty points than the plan gives them. Regenerate, or change the plan first.', 'למישהו יש יותר נקודות תורנות ממה שהתוכנית נותנת לו. יש לשבץ מחדש או לשנות קודם את התוכנית.');
  if (/ineligible-primary|An engineer is no longer active|An active engineer is required|Unknown approved team member/.test(message)) return t('A duty is assigned to someone who isn’t an active team member here. Choose someone else.', 'תורנות משובצת למישהו שאינו חבר צוות פעיל. יש לבחור מישהו אחר.');
  if (/overlapping-primary|Duty dates overlap|Published duty dates overlap|overlapping-published-duty/.test(message)) return t('Two duties overlap for the same person. Change one of them.', 'שתי תורנויות חופפות לאותו אדם. יש לשנות אחת מהן.');
  if (/A primary engineer cannot also be emergency cover|secondary-changed|invalid-secondary|Emergency engineer is inactive/.test(message)) return t('Emergency cover must be an active member other than the primary. Choose someone else for cover.', 'כיסוי החירום חייב להיות חבר פעיל שאינו התורן הראשי. יש לבחור מישהו אחר לכיסוי.');
  if (/This swap would create a second weekend/.test(message)) return t('This swap would give someone a second weekend this month. Choose other duties, or decline or reject it.', 'ההחלפה הזו תיתן למישהו סוף שבוע שני החודש. יש לבחור תורנויות אחרות, או לסרב לה או לדחות אותה.');
  if (/consecutive-primary|weekend-cap/.test(message)) return t('Locked duties put someone on back-to-back days or a second weekend. Review those locks in the calendar.', 'תורנויות נעולות שמות מישהו בימים רצופים או בסוף שבוע שני. יש לבדוק את הנעילות האלה בלוח.');
  if (/split-not-friday|duplicate-split|invalid-special|invalid-half-points|noncanonical-duty|invalid-published-duty/.test(message)) return t('A weekend split or special day doesn’t match the calendar. Refresh the month and set it again.', 'פיצול סוף שבוע או יום מיוחד אינו תואם ללוח. יש לרענן את החודש ולהגדיר אותו שוב.');
  if (/stale-generation|stale-request|stale-publication|stale-allocation|altered-generation-result/.test(message)) return t('The month changed in another tab, so this was refreshed. Check it, then try again.', 'החודש השתנה בכרטיסייה אחרת ולכן רוענן. כדאי לבדוק ולנסות שוב.');
  if (/This browser cannot|הדפדפן אינו/.test(message)) return message;
  // Already names what changed in the points ledger (useAllocationWorkflow's `changed`).
  if (/\(balances: |\(מאזנים: |^\S.* changed, so the month was refreshed|השתנה, ולכן החודש רוענן/.test(message)) return message;
  // Plans the ledger can't book, explained before Generate (see bookingProblem).
  if (/review-compound-reverse-obligation/.test(message)) return t('A point passes through someone who owes it back, so this plan can’t be booked. Undo the last change, or drag the point straight to who should do it.', 'נקודה עוברת דרך מי שחייב אותה בחזרה, ולכן לא ניתן לרשום את התוכנית. אפשר לבטל את השינוי האחרון, או לגרור את הנקודה ישירות למי שיבצע אותה.');
  if (/review-unavailable-reverse-obligation/.test(message)) return t('Someone is handed back more points than they still owe, so this plan can’t be booked. Make that point permanent, hand over fewer points, or undo the last change.', 'מישהו מקבל בחזרה יותר נקודות ממה שהוא עדיין חייב, ולכן לא ניתן לרשום את התוכנית. אפשר להפוך את הנקודה לקבועה, להעביר פחות נקודות, או לבטל את השינוי האחרון.');
  if (/review-normalized-deferral-route/.test(message)) return t('A postponed repayment would pass through several people, so this plan can’t be booked. Undo the last change.', 'החזר שנדחה היה עובר דרך כמה אנשים, ולכן לא ניתן לרשום את התוכנית. אפשר לבטל את השינוי האחרון.');
  // A database without the re-plan migrations still refuses to change a published plan.
  if (/Review published transfer lineage/.test(message)) return t('This database can’t re-plan a published month yet: its migrations are out of date. Apply them (pnpm start:local or pnpm local:setup), then try again.', 'מסד הנתונים עדיין לא תומך בתכנון מחדש של חודש שפורסם: המיגרציות שלו אינן מעודכנות. יש להחיל אותן (pnpm start:local או pnpm local:setup) ולנסות שוב.');
  if (/review-existing-reservation-normalization/.test(message)) return t('This plan would change a debt another month already repays, so it can’t be booked. Undo the last change, or change that month first.', 'התוכנית הייתה משנה חוב שחודש אחר כבר מחזיר, ולכן לא ניתן לרשום אותה. אפשר לבטל את השינוי האחרון, או לשנות קודם את החודש ההוא.');
  if (/review-circular-route/.test(message)) return t('A point someone lent comes back to them, so this plan can’t be booked. Undo the last change.', 'נקודה שמישהו העביר חוזרת אליו, ולכן לא ניתן לרשום את התוכנית. אפשר לבטל את השינוי האחרון.');
  // A published month's plan is replaced from the ledger without its own entries, unless (decision 2026-11-01):
  const later = /review-replan-later:(\d{4}-\d{2})/.exec(message)?.[1];
  if (later) {
    const name = (lang: string) => new Date(`${later}-15T00:00:00Z`).toLocaleString(lang, {month: 'long', year: 'numeric', timeZone: 'UTC'});
    return t(`${name('en')} is already planned from this month’s points, so change ${name('en')} first.`, `${name('he')} כבר תוכנן על סמך הנקודות של החודש הזה, ולכן יש לשנות קודם את ${name('he')}.`);
  }
  if (/review-replan-later:unknown/.test(message)) return t('A month that is no longer published already repaid from this month’s points, so its plan can’t be replaced. Change single duties in the calendar instead.', 'חודש שכבר אינו מפורסם כבר החזיר מהנקודות של החודש הזה, ולכן לא ניתן להחליף את התוכנית שלו. אפשר לשנות תורנויות בודדות בלוח.');
  if (/review-replan-started/.test(message)) return t('This month has started, so its plan can’t be replaced. Change single duties in the calendar instead.', 'החודש הזה כבר התחיל, ולכן לא ניתן להחליף את התוכנית שלו. אפשר לשנות תורנויות בודדות בלוח.');
  if (/review-replan-settled/.test(message)) return t('A repayment from this month’s points was settled by hand, so its plan can’t be replaced.', 'החזר מהנקודות של החודש הזה נרשם ידנית, ולכן לא ניתן להחליף את התוכנית שלו.');
  if (/review-allocation-booking/.test(message)) return t('This plan can’t be booked as it is. Undo the last change, then try again.', 'לא ניתן לרשום את התוכנית כפי שהיא. אפשר לבטל את השינוי האחרון ולנסות שוב.');
  if (/invalid-ordinary-baseline/.test(message)) return t('This month’s duties can’t split that way, so a new proposal replaced it. Check it, then confirm again.', 'לא ניתן לחלק כך את תורנויות החודש ולכן הוחלפה ההקצאה בהצעה חדשה. כדאי לבדוק ולאשר שוב.');
  if (/uneven-credit/.test(message)) return t('This month’s uneven split credit needed a fresh proposal, so one replaced it. Check it, then confirm again.', 'הזיכוי על החלוקה הלא שווה החודש דרש הצעה חדשה, והיא הוחלפה. כדאי לבדוק ולאשר שוב.');
  if (/allocation-fit-limit/.test(message)) return t('This month’s duty points are too irregular to split automatically. Simplify the special ranges, then try again.', 'נקודות התורנויות בחודש זה אינן סדירות מכדי לחלק אותן אוטומטית. יש לפשט את טווחי הימים המיוחדים ולנסות שוב.');
  if (/statement timeout/.test(message)) return t('The server took too long to check this month’s split. Try again; if it repeats, simplify the special ranges.', 'בדיקת החלוקה החודשית בשרת ארכה זמן רב מדי. יש לנסות שוב; אם הבעיה חוזרת, יש לפשט את טווחי הימים המיוחדים.');
  if (/Ordinary baseline/.test(message)) return t('Keep the confirmed allocation and adjust Temporary or Permanent. The month weights and participating team have not changed.', 'יש לשמור על ההקצאה המאושרת ולערוך את השינוי הזמני או הקבוע. משקלי החודש והצוות המשתתף לא השתנו.');
  if (/permanent-below-fair-share/.test(message)) return t('A permanent change can’t take away more than the engineer’s own share: the fair share, or work already given as relief.', 'שינוי קבוע אינו יכול להוריד יותר מהחלק של המהנדס עצמו: החלק ההוגן, או עבודה שכבר ניתנה כהקלה.');
  if (/permanent-above-month-total/.test(message)) return t('A fair share plus a permanent change can’t exceed this month’s total points.', 'החלק ההוגן בתוספת שינוי קבוע אינו יכול לעלות על סך הנקודות של החודש.');
  if (/temporary-above-month-total/.test(message)) return t('No one can owe or be owed more than this month’s total points.', 'אף אחד לא יכול לחוב או שיחובו לו יותר מסך הנקודות של החודש.');
  if (/unplaced-allocation-change/.test(message)) return t('No one else can take this change, so the plan would no longer match the month. Drag a point instead.', 'אין מי שיכול לקבל את השינוי, ולכן התוכנית לא הייתה תואמת את החודש. אפשר לגרור נקודה במקום.');
  if (/allocation-above-month-total/.test(message)) return t('No one else can take on less, so this would add points the month doesn’t have. Lower someone first.', 'אין מי שיכול לקבל פחות, ולכן זה היה מוסיף נקודות שאין בחודש. יש להוריד קודם למישהו אחר.');
  if (/unbalanced-allocation-changes/.test(message)) return t('Place the remaining points with the + and − controls.', 'יש לחלק את הנקודות שנותרו באמצעות לחצני + ו־−.');
  if (/invalid-allocation-shape|invalid-allocation-changes|invalid-derived-transfers|invalid-allocation-pair|invalid-hand-edits/.test(message)) return t('The saved allocation used an earlier format, so a new proposal replaced it. Check it, then confirm again.', 'ההקצאה השמורה נשמרה בפורמט ישן ולכן הוחלפה בהצעה חדשה. כדאי לבדוק ולאשר שוב.');
  if (/lineage|compound|ambiguous/.test(message)) return t('This month carries a published adjustment that needs review. Keep its original plan before changing transfers.', 'בחודש זה קיים שינוי שפורסם ודורש בדיקה. יש לשמור על התוכנית המקורית לפני שינוי העברות.');
  if (/target-total-mismatch|invalid-baseline-total/.test(message)) return t('Targets must add up to the required month total. Place the remaining points or undo.', 'סכום היעדים חייב להתאים לסך הנקודות לחודש. יש לחלק את הנקודות שנותרו או לבטל את השינוי.');
  if (/locked-points|lock.*target|target.*lock/.test(message)) return t('A target is below its locked points. Increase it or explicitly unlock duties.', 'יעד נמוך מהנקודות הנעולות. יש להגדיל אותו או לבטל נעילות במפורש.');
  if (/ineligible-lock|availability-approval/.test(message)) return t('A locked engineer is unavailable. Review the assignment in the calendar or unlock it.', 'המהנדס הנעול אינו זמין. יש לבדוק את השיבוץ בלוח או לבטל את הנעילה.');
  if (/consecutive|weekend|boundary|approval|fixed-/.test(message)) return t('Fixed duties conflict. Review or unlock the conflicting assignments in the calendar.', 'קיים קונפליקט בין תורנויות קבועות. יש לבדוק את השיבוצים המתנגשים בלוח או לבטל את נעילתם.');
  if (/generation-window-closed/.test(message)) return t('Coverage has started. Use manual assignments or swaps.', 'הכיסוי החודשי התחיל. יש לערוך שיבוצים ידנית או לבצע החלפות.');
  // The checked RPCs' own sentences, each in both languages, before the generic
  // "changed" fallbacks below, which would otherwise swallow e.g. a swap's invalidation.
  const said = SENTENCES.find(([pattern]) => pattern.test(message));
  if (said) return t(said[1], said[2]);
  // Say what changed: the points ledger, or the team and calendar.
  if (/Compensation changed/.test(message)) return t('Points changed since this plan was made (another month was published or a repayment was recorded), so the month was refreshed and your targets were kept. Check them, then confirm again.', 'הנקודות השתנו מאז שהתוכנית נבנתה (חודש אחר פורסם או נרשם החזר), ולכן החודש רוענן והיעדים נשמרו. כדאי לבדוק ולאשר שוב.');
  if (/stale|changed|revision|fingerprint/i.test(message)) return t('Team data changed, so the month was refreshed and your targets were kept. Check them, then confirm again.', 'נתוני הצוות השתנו, החודש רוענן והיעדים נשמרו. כדאי לבדוק ולאשר שוב.');
  if (/Worker|WASM|fetch|load failed/i.test(message)) return t('The planner could not start. Check your connection, then try again in a current browser. Your saved draft is kept.', 'לא ניתן להפעיל את המתכנן. יש לבדוק את החיבור ולנסות שוב בדפדפן עדכני. הטיוטה השמורה נשמרה.');
  if (/repayment|source|allocation-members|target-members|offered|seniority/.test(message)) return t('Team or compensation changes needed a fresh review. The month was refreshed; check the targets, then confirm again.', 'שינויים בצוות או בפיצוי דרשו בדיקה מחדש. החודש רוענן; כדאי לבדוק את היעדים ולאשר שוב.');
  // Internal accounting and input checks a user can't reach directly: nothing was saved.
  if (/^[a-z][a-z0-9-]*(:.*)?$/.test(message) || /^(Invalid|Missing|Non-binary|Duplicate|Ineligible)\b/.test(message)) {
    return t('This change couldn’t be saved because it would break the schedule’s records. Nothing changed. Refresh the month and try again.', 'לא ניתן היה לשמור את השינוי כי הוא היה פוגע ברישומי הלוח. דבר לא השתנה. יש לרענן את החודש ולנסות שוב.');
  }
  return message;
}

const SENTENCES: readonly (readonly [RegExp, string, string])[] = [
  // Solver and validation internals: Generate didn't finish; nothing was saved.
  [/Prior objective degraded|Threshold violated|Objective mismatch|contradicts verified incumbent|Unbalanced\/oversized targets|Wrong assignment length|Noncanonical generation context|solver-domain-validation-mismatch/, 'Generate couldn’t finish. Try again, or adjust the plan.', 'השיבוץ לא הושלם. אפשר לנסות שוב או לשנות את התוכנית.'],
  [/Weekend cap exceeded by fixed duties/, 'Locked duties give someone a second weekend. Review those locks in the calendar.', 'תורנויות נעולות נותנות למישהו סוף שבוע שני. יש לבדוק את הנעילות האלה בלוח.'],
  [/^Target exceeded/, 'Someone has more duty points than the plan gives them. Regenerate, or change the plan first.', 'למישהו יש יותר נקודות תורנות ממה שהתוכנית נותנת לו. יש לשבץ מחדש או לשנות קודם את התוכנית.'],
  [/^Overlapping duties/, 'Two duties overlap for the same person. Change one of them.', 'שתי תורנויות חופפות לאותו אדם. יש לשנות אחת מהן.'],
  [/The duty lock was not saved as requested/, 'The lock wasn’t saved as requested. Refresh, check the duty, then try again.', 'הנעילה לא נשמרה כמבוקש. יש לרענן, לבדוק את התורנות ולנסות שוב.'],
  [/Please wait for the current save/, 'Wait for the current save to finish.', 'יש להמתין לסיום השמירה הנוכחית.'],
  [/This request was invalidated because its published duties/, 'This swap request no longer applies: its duties changed. Ask for a new swap.', 'בקשת ההחלפה כבר לא רלוונטית: התורנויות שלה השתנו. יש לבקש החלפה חדשה.'],
  [/Sign in with an approved account first|Not connected/, 'Sign in with an approved account first.', 'יש להתחבר קודם עם חשבון מאושר.'],
  [/Could not check Google sign-in|Could not complete inspection login/, 'Google sign-in didn’t finish. Try signing in again.', 'ההתחברות עם Google לא הושלמה. יש לנסות להתחבר שוב.'],
  [/Google sign-in is not enabled yet/, 'Google sign-in isn’t set up yet. The manager needs to finish the Google setup in Supabase.', 'ההתחברות עם Google עדיין לא הוגדרה. המנהל צריך להשלים את הגדרת Google ב־Supabase.'],
  [/Password login is available only for LOCAL|Use a local test account/, 'Password sign-in works only on the local test environment. Use a local test account.', 'התחברות עם סיסמה פועלת רק בסביבת הבדיקה המקומית. יש להשתמש בחשבון בדיקה מקומי.'],
  [/The team connection is not configured yet|Unknown Supabase project|Only a public Supabase key is supported|Runtime origin and Supabase project do not match|Unexpected Supabase destination|Use your exact HTTPS ngrok development origin/, 'The app isn’t connected to the right team database. Check the connection settings, then reload.', 'האפליקציה אינה מחוברת למסד הנתונים הנכון של הצוות. יש לבדוק את הגדרות החיבור ולטעון מחדש.'],
  [/Not an inspection session|Production inspection can sign out only its own session/, 'This inspection session can only sign itself out.', 'סשן הבדיקה הזה יכול רק להתנתק בעצמו.'],
  [/was re-planned after this version/, 'That month was re-planned after this version, so its points can’t come back. Reopen the month and change its plan instead.', 'החודש תוכנן מחדש אחרי הגרסה הזו, ולכן הנקודות שלה לא יכולות לחזור. יש לפתוח מחדש את החודש ולשנות את התוכנית שלו.'],
  [/A reopened published month is required|Reopen the draft first/, 'Reopen the month for editing first.', 'יש לפתוח קודם את החודש לעריכה.'],
  [/A verified account is required|Sign in first/, 'Sign in first.', 'יש להתחבר קודם.'],
  [/Admin access required|Not allowed|Allocation accounting is server-owned/, 'Only an admin can do this.', 'רק מנהל יכול לעשות זאת.'],
  [/Member access required|Your membership is not approved/, 'Your membership isn’t approved yet. Ask an admin to approve it.', 'החברות שלך עדיין לא אושרה. יש לבקש ממנהל לאשר אותה.'],
  [/Allocation too large/, 'This plan is too large to save. Undo some changes, then try again.', 'התוכנית גדולה מכדי לשמור אותה. יש לבטל חלק מהשינויים ולנסות שוב.'],
  [/An open month draft is required|Duty requires its owning month draft|Edit duties in their owning month/, 'Edit this month’s draft first: open the month, then try again.', 'יש לערוך קודם את טיוטת החודש: לפתוח את החודש ולנסות שוב.'],
  [/Approve this member first/, 'Approve this member first.', 'יש לאשר קודם את החבר הזה.'],
  [/Calendar changed\. Confirm allocation again/, 'The month’s calendar changed. Confirm the plan again.', 'לוח החודש השתנה. יש לאשר שוב את התוכנית.'],
  [/Choose duties in the same current publication|Choose duties owned by the same published month/, 'Choose two duties from the same published month.', 'יש לבחור שתי תורנויות מאותו חודש שפורסם.'],
  [/Choose duties starting today or later/, 'Choose duties from today on.', 'יש לבחור תורנויות מהיום והלאה.'],
  [/Choose two different primary engineers/, 'Choose two different people.', 'יש לבחור שני אנשים שונים.'],
  [/Choose your own primary duty/, 'Choose one of your own duties.', 'יש לבחור אחת מהתורנויות שלך.'],
  [/Compensation audit history is append-only/, 'Points history can’t be changed, only added to.', 'אי אפשר לשנות את היסטוריית הנקודות, רק להוסיף לה.'],
  [/Complete allocation required for publication|Confirmed allocation required/, 'Confirm the plan and generate the month before publishing.', 'יש לאשר את התוכנית ולשבץ את החודש לפני הפרסום.'],
  [/Constraints are closed for this month/, 'Availability for this month is closed.', 'הזמינות לחודש הזה נסגרה.'],
  [/Engineer consent already recorded|Your answer is already recorded/, 'You already answered this request.', 'כבר ענית לבקשה הזו.'],
  [/The team data changed\. Refresh|stale revision/, 'The schedule changed in another tab or by someone else, so it was refreshed. Check it, then try again.', 'הלוח השתנה בכרטיסייה אחרת או על ידי מישהו אחר, ולכן רוענן. כדאי לבדוק ולנסות שוב.'],
  [/Generation inputs changed|Invalid team data/, 'Team data changed, so the month was refreshed and your targets were kept. Check them, then confirm again.', 'נתוני הצוות השתנו, החודש רוענן והיעדים נשמרו. כדאי לבדוק ולאשר שוב.'],
  [/Repayment capacity changed|Repayment lineage changed/, 'A repayment changed since this was opened, so the month was refreshed. Check it, then try again.', 'החזר השתנה מאז שזה נפתח, ולכן החודש רוענן. כדאי לבדוק ולנסות שוב.'],
  [/Invalid generation result/, 'The generated schedule didn’t match this month. Generate again.', 'השיבוץ שנוצר לא תאם את החודש. יש לשבץ שוב.'],
  [/Invalid compensation|Invalid review|Invalid swap action|Invalid schedule|Invalid constraints|Invalid date|Source key and reason required/, 'This change couldn’t be saved because it would break the schedule’s records. Nothing changed. Refresh the month and try again.', 'לא ניתן היה לשמור את השינוי כי הוא היה פוגע ברישומי הלוח. דבר לא השתנה. יש לרענן את החודש ולנסות שוב.'],
  [/Keep at least one active admin/, 'Keep at least one active admin.', 'יש להשאיר לפחות מנהל פעיל אחד.'],
  [/Only the current counterpart can respond/, 'Only the person asked can answer this request.', 'רק האדם שנשאל יכול לענות לבקשה הזו.'],
  [/Only the requester can cancel|Only the person who started the request can cancel/, 'Only the person who started this request can cancel it.', 'רק מי שיזם את הבקשה הזו יכול לבטל אותה.'],
  [/Request not found|This request is no longer pending/, 'This request was already answered or cancelled.', 'הבקשה הזו כבר נענתה או בוטלה.'],
  [/Review missing allocation publication lineage/, 'This month’s plan wasn’t saved with its publication. Reopen the month and confirm its plan again.', 'התוכנית של החודש לא נשמרה עם הפרסום שלו. יש לפתוח מחדש את החודש ולאשר שוב את התוכנית.'],
  [/Temporary member required/, 'Choose a temporary member.', 'יש לבחור חבר זמני.'],
  [/The counterpart changed\. Refresh first|This publication changed\. Request a new swap/, 'The schedule changed since this request. Ask for a new swap.', 'הלוח השתנה מאז הבקשה. יש לבקש החלפה חדשה.'],
  [/The current engineer must accept before admin review|Both engineers must accept before admin review/, 'Both engineers have to accept before an admin reviews it.', 'שני המהנדסים צריכים לאשר לפני שמנהל יבדוק.'],
  [/Use Publish to publish a draft/, 'Use Publish to publish the draft.', 'יש להשתמש בכפתור הפרסום כדי לפרסם את הטיוטה.'],
  [/Use a name between 1 and 80 characters/, 'Use a name between 1 and 80 characters.', 'יש להשתמש בשם באורך 1 עד 80 תווים.'],
  [/Version no longer exists/, 'This version was already deleted. Refresh the list.', 'הגרסה הזו כבר נמחקה. יש לרענן את הרשימה.'],
];
