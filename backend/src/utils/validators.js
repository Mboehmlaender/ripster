function parseJson(value, fallback = null) {
  if (!value) {
    return fallback;
  }

  try {
    return JSON.parse(value);
  } catch (error) {
    return fallback;
  }
}

function toBoolean(value) {
  if (typeof value === 'boolean') {
    return value;
  }

  if (value === 'true' || value === '1' || value === 1) {
    return true;
  }

  if (value === 'false' || value === '0' || value === 0) {
    return false;
  }

  return Boolean(value);
}

function normalizeValueByType(type, rawValue) {
  if (rawValue === undefined || rawValue === null) {
    return null;
  }

  switch (type) {
    case 'number':
      return Number(rawValue);
    case 'boolean':
      return toBoolean(rawValue);
    case 'select':
    case 'string':
    case 'path':
    default:
      return String(rawValue);
  }
}

function serializeValueByType(type, value) {
  if (value === undefined || value === null) {
    return null;
  }

  if (type === 'boolean') {
    return value ? 'true' : 'false';
  }

  return String(value);
}

function validateSetting(schemaItem, value) {
  const errors = [];
  const normalized = normalizeValueByType(schemaItem.type, value);

  if (schemaItem.required) {
    const emptyString = typeof normalized === 'string' && normalized.trim().length === 0;
    if (normalized === null || emptyString) {
      errors.push('Wert ist erforderlich.');
    }
  }

  if (schemaItem.type === 'number' && normalized !== null) {
    if (Number.isNaN(normalized)) {
      errors.push('Ungültige Zahl.');
    } else {
      const rules = parseJson(schemaItem.validation_json, {});
      if (typeof rules.min === 'number' && normalized < rules.min) {
        errors.push(`Wert muss >= ${rules.min} sein.`);
      }
      if (typeof rules.max === 'number' && normalized > rules.max) {
        errors.push(`Wert muss <= ${rules.max} sein.`);
      }
    }
  }

  if (schemaItem.type === 'select' && normalized !== null) {
    const options = parseJson(schemaItem.options_json, []);
    const values = options.map((option) => option.value);
    if (!values.includes(normalized)) {
      errors.push('Ungültige Auswahl.');
    }
  }

  if ((schemaItem.type === 'path' || schemaItem.type === 'string') && normalized !== null) {
    const rules = parseJson(schemaItem.validation_json, {});
    if (typeof rules.minLength === 'number' && normalized.length < rules.minLength) {
      errors.push(`Wert muss mindestens ${rules.minLength} Zeichen haben.`);
    }
  }

  return {
    valid: errors.length === 0,
    errors,
    normalized
  };
}

module.exports = {
  parseJson,
  normalizeValueByType,
  serializeValueByType,
  validateSetting,
  toBoolean
};
