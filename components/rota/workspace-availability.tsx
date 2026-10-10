import {
  Select,
  SelectTrigger,
  SelectValue,
  SelectContent,
  SelectItem,
} from '@/components/ui/select';
import { AvailabilityEditor } from '@/components/rota/availability-editor';
import type { State } from '@/lib/rota/engine';
import type { Language, Translate } from './workspace-types';
function Picker({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  label: string;
}) {
  return (
    <Select value={value} onValueChange={onChange}>
      <SelectTrigger aria-label={label} className="picker">
        <SelectValue />
      </SelectTrigger>
      <SelectContent>
        {options.map((o) => (
          <SelectItem value={o.value} key={o.value}>
            {o.label}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
export function WorkspaceAvailability({
  state,
  month,
  person,
  setPerson,
  dateCells,
  lang,
  isManager,
  meId,
  constraintsClosed,
  t,
  saveConstraints,
}: {
  state: State;
  month: string;
  person: string;
  setPerson: (id: string) => void;
  dateCells: string[];
  lang: Language;
  isManager: boolean;
  meId: string;
  constraintsClosed: boolean;
  t: Translate;
  saveConstraints: (
    days: string[],
    kind: 'no' | 'prefer' | 'clear',
    note: string,
  ) => Promise<boolean>;
}) {
  const active = state.team.filter((p) => p.active);
  return (
    <section className="availability-panel">
      <div className="section-heading">
        <h3>{t('Constraints', 'אילוצים')}</h3>
        <Picker
          value={person}
          onChange={(v) => {
            if (isManager) setPerson(v);
          }}
          label={t('Engineer', 'מהנדס')}
          options={(isManager ? active : active.filter((p) => p.id === meId)).map((p) => ({
            value: p.id,
            label: p.name + (p.id === meId ? t(' (you)', ' (אני)') : ''),
          }))}
        />
      </div>
      <AvailabilityEditor
        state={state}
        month={month}
        person={person}
        cells={dateCells}
        lang={lang}
        disabled={constraintsClosed}
        onSave={saveConstraints}
      />
      {constraintsClosed && (
        <div className="inline-note">
          {isManager
            ? t('Reopen the draft to edit constraints.', 'יש לפתוח טיוטה לעריכת אילוצים.')
            : t('Constraints are closed for this month.', 'הזנת האילוצים לחודש זה נסגרה.')}
        </div>
      )}
    </section>
  );
}
