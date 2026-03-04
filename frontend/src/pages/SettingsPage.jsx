import { useEffect, useMemo, useRef, useState } from 'react';
import { Card } from 'primereact/card';
import { Button } from 'primereact/button';
import { Toast } from 'primereact/toast';
import { api } from '../api/client';
import DynamicSettingsForm from '../components/DynamicSettingsForm';

function buildValuesMap(categories) {
  const next = {};
  for (const category of categories || []) {
    for (const setting of category.settings || []) {
      next[setting.key] = setting.value;
    }
  }
  return next;
}

function isSameValue(a, b) {
  if (typeof a === 'number' && typeof b === 'number') {
    return Number(a) === Number(b);
  }
  return a === b;
}

export default function SettingsPage() {
  const [categories, setCategories] = useState([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testingPushover, setTestingPushover] = useState(false);
  const [initialValues, setInitialValues] = useState({});
  const [draftValues, setDraftValues] = useState({});
  const [errors, setErrors] = useState({});
  const toastRef = useRef(null);

  const load = async () => {
    setLoading(true);
    try {
      const response = await api.getSettings();
      const nextCategories = response.categories || [];
      const values = buildValuesMap(nextCategories);
      setCategories(nextCategories);
      setInitialValues(values);
      setDraftValues(values);
      setErrors({});
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'Fehler', detail: error.message });
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
  }, []);

  const dirtyKeys = useMemo(() => {
    const keys = new Set();
    const allKeys = new Set([...Object.keys(initialValues), ...Object.keys(draftValues)]);
    for (const key of allKeys) {
      if (!isSameValue(initialValues[key], draftValues[key])) {
        keys.add(key);
      }
    }
    return keys;
  }, [initialValues, draftValues]);

  const hasUnsavedChanges = dirtyKeys.size > 0;

  const handleFieldChange = (key, value) => {
    setDraftValues((prev) => ({ ...prev, [key]: value }));
    setErrors((prev) => ({ ...prev, [key]: null }));
  };

  const handleSave = async () => {
    if (!hasUnsavedChanges) {
      toastRef.current?.show({
        severity: 'info',
        summary: 'Settings',
        detail: 'Keine Änderungen zum Speichern.'
      });
      return;
    }

    const patch = {};
    for (const key of dirtyKeys) {
      patch[key] = draftValues[key];
    }

    setSaving(true);
    try {
      const response = await api.updateSettingsBulk(patch);
      setInitialValues((prev) => ({ ...prev, ...patch }));
      setErrors({});
      const reviewRefresh = response?.reviewRefresh || null;
      const reviewRefreshHint = reviewRefresh?.triggered
        ? ' Mediainfo-Prüfung wird mit den neuen Settings automatisch neu berechnet.'
        : '';
      toastRef.current?.show({
        severity: 'success',
        summary: 'Settings',
        detail: `${Object.keys(patch).length} Änderung(en) gespeichert.${reviewRefreshHint}`
      });
    } catch (error) {
      let detail = error?.message || 'Unbekannter Fehler';
      if (Array.isArray(error?.details)) {
        const nextErrors = {};
        for (const item of error.details) {
          if (item?.key) {
            nextErrors[item.key] = item.message || 'Ungültiger Wert';
          }
        }
        setErrors(nextErrors);
        detail = 'Mindestens ein Feld ist ungültig.';
      }
      toastRef.current?.show({ severity: 'error', summary: 'Speichern fehlgeschlagen', detail });
    } finally {
      setSaving(false);
    }
  };

  const handleDiscard = () => {
    setDraftValues(initialValues);
    setErrors({});
  };

  const handlePushoverTest = async () => {
    setTestingPushover(true);
    try {
      const response = await api.testPushover();
      const sent = response?.result?.sent;
      if (sent) {
        toastRef.current?.show({
          severity: 'success',
          summary: 'PushOver',
          detail: 'Testnachricht wurde versendet.'
        });
      } else {
        toastRef.current?.show({
          severity: 'warn',
          summary: 'PushOver',
          detail: `Nicht versendet (${response?.result?.reason || 'unbekannt'}).`
        });
      }
    } catch (error) {
      toastRef.current?.show({ severity: 'error', summary: 'PushOver Fehler', detail: error.message });
    } finally {
      setTestingPushover(false);
    }
  };

  return (
    <div className="page-grid">
      <Toast ref={toastRef} />

      <Card title="Einstellungen" subTitle="Änderungen werden erst beim Speichern in die Datenbank übernommen">
        <div className="actions-row">
          <Button
            label="Änderungen speichern"
            icon="pi pi-save"
            onClick={handleSave}
            loading={saving}
            disabled={!hasUnsavedChanges}
          />
          <Button
            label="Änderungen verwerfen"
            icon="pi pi-undo"
            severity="secondary"
            outlined
            onClick={handleDiscard}
            disabled={!hasUnsavedChanges || saving}
          />
          <Button
            label="Neu laden"
            icon="pi pi-refresh"
            severity="secondary"
            onClick={load}
            loading={loading}
            disabled={saving}
          />
          <Button
            label="PushOver Test"
            icon="pi pi-send"
            severity="info"
            onClick={handlePushoverTest}
            loading={testingPushover}
            disabled={saving}
          />
        </div>

        {loading ? (
          <p>Lade Settings ...</p>
        ) : (
          <DynamicSettingsForm
            categories={categories}
            values={draftValues}
            errors={errors}
            dirtyKeys={dirtyKeys}
            onChange={handleFieldChange}
          />
        )}
      </Card>
    </div>
  );
}
