import type {Environment} from '@/lib/supabase/environment';

export function EnvironmentBadge({environment}:{environment:Environment|null}) {
 return environment?.badge ? <span className={`environment-badge environment-${environment.target}`} aria-label={`Environment: ${environment.badge}`}>{environment.badge}</span> : null;
}
export function InspectionWarning({environment,lang}:{environment:Environment|null;lang:'en'|'he'}) {
 return environment?.readOnly ? <div className="inspection-warning" role="note">{lang==='he'
  ? 'בדיקת Production · כתיבת נתוני הצוות והצטרפות אליו חסומות. השתמשו רק בחשבון Production קיים. אימות עשוי לעדכן זהויות וחיבורים. זו הגנה באפליקציה ולא הרשאת קריאה בלבד במסד הנתונים.'
  : 'Production inspection · Team data writes and membership onboarding are disabled. Use an existing Production identity only. Authentication can update identities and sessions. This is an application safeguard, not database-enforced read-only access.'}</div> : null;
}
