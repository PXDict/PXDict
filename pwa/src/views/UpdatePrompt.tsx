// Offers to reload when a new version of the app has been downloaded.
import { useEffect, useState } from "preact/hooks";
import { t } from "../i18n";
import { applyUpdate, isUpdateWaiting, onUpdateWaiting } from "../lib/update";

export function UpdatePrompt() {
  const [waiting, setWaiting] = useState(isUpdateWaiting());
  const [dismissed, setDismissed] = useState(false);
  useEffect(() => onUpdateWaiting(setWaiting), []);
  if (!waiting || dismissed) return null;
  return (
    <div class="toast" role="status">
      <span>{t("update.available")}</span>
      <button type="button" class="btn btn-small btn-primary" onClick={() => void applyUpdate()}>
        {t("update.reload")}
      </button>
      <button type="button" class="link" onClick={() => { setDismissed(true); }}>
        {t("update.later")}
      </button>
    </div>
  );
}
