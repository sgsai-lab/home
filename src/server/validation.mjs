import { sanitizeText, validationError } from './http.mjs';

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
export const SECTORS = ['business', 'education'];

/** Collects field problems so a request reports all of them at once. */
export class Checker {
  constructor(input) {
    this.input = input ?? {};
    this.details = [];
    this.output = {};
  }

  has(field) {
    return Object.hasOwn(this.input, field) && this.input[field] !== undefined;
  }

  fail(field, message) {
    this.details.push({ field, message });
    return undefined;
  }

  text(field, { required = false, max = 200, min = 0, nullable = false } = {}) {
    if (!this.has(field)) return required ? this.fail(field, 'This field is required.') : undefined;
    if (this.input[field] === null && nullable && !required) return (this.output[field] = null);
    const value = sanitizeText(this.input[field], max);
    if (!value && required) return this.fail(field, 'This field is required.');
    if (value.length < min) return this.fail(field, `Use at least ${min} characters.`);
    this.output[field] = value || (nullable ? null : '');
    return this.output[field];
  }

  email(field, { required = true } = {}) {
    const value = this.text(field, { required, max: 254 });
    if (value === undefined) return undefined;
    if (!EMAIL_PATTERN.test(value)) return this.fail(field, 'Enter a valid email address.');
    this.output[field] = value.toLowerCase();
    return this.output[field];
  }

  oneOf(field, options, { required = false } = {}) {
    if (!this.has(field)) return required ? this.fail(field, 'This field is required.') : undefined;
    if (!options.includes(this.input[field])) return this.fail(field, `Use one of: ${options.join(', ')}.`);
    this.output[field] = this.input[field];
    return this.output[field];
  }

  date(field) {
    if (!this.has(field)) return undefined;
    const value = this.input[field];
    if (value === null || value === '') return (this.output[field] = null);
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || Number.isNaN(Date.parse(`${value}T00:00:00Z`))) {
      return this.fail(field, 'Use the YYYY-MM-DD format.');
    }
    this.output[field] = value;
    return value;
  }

  url(field, { required = false, nullable = true } = {}) {
    if (!this.has(field)) return required ? this.fail(field, 'This field is required.') : undefined;
    const raw = this.input[field];
    if ((raw === null || raw === '') && nullable && !required) return (this.output[field] = null);
    let parsed;
    try {
      parsed = new URL(String(raw));
    } catch {
      return this.fail(field, 'Enter a full https:// address.');
    }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) return this.fail(field, 'Only https:// addresses without credentials are allowed.');
    if (parsed.href.length > 500) return this.fail(field, 'Use at most 500 characters.');
    this.output[field] = parsed.href;
    return parsed.href;
  }

  tags(field, { maxItems = 20, maxLength = 32 } = {}) {
    if (!this.has(field)) return undefined;
    const value = this.input[field];
    if (!Array.isArray(value)) return this.fail(field, 'Expected a list.');
    const tags = [...new Set(value.map((tag) => sanitizeText(tag, 100).toLowerCase()).filter(Boolean))];
    if (tags.length > maxItems) return this.fail(field, `Use at most ${maxItems} items.`);
    if (tags.some((tag) => tag.length > maxLength)) return this.fail(field, `Each item can be at most ${maxLength} characters.`);
    this.output[field] = tags;
    return tags;
  }

  integer(field, { min = 0, max = 1_000_000 } = {}) {
    if (!this.has(field)) return undefined;
    const value = this.input[field];
    if (!Number.isInteger(value) || value < min || value > max) return this.fail(field, `Use a whole number between ${min} and ${max}.`);
    this.output[field] = value;
    return value;
  }

  boolean(field) {
    if (!this.has(field)) return undefined;
    if (typeof this.input[field] !== 'boolean') return this.fail(field, 'Expected true or false.');
    this.output[field] = this.input[field];
    return this.input[field];
  }

  done() {
    if (this.details.length) throw validationError(this.details);
    return this.output;
  }
}

export function slugify(value) {
  return String(value ?? '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

export const SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,58}[a-z0-9])?$/;

/** Shared list parameters: page, page_size (≤ 50), sort. */
export function pageParams(query, { sortFields, defaultSort = '-created_at', maxPageSize = 50 }) {
  const page = Math.max(1, Number.parseInt(query.get('page') ?? '1', 10) || 1);
  const pageSize = Math.min(maxPageSize, Math.max(1, Number.parseInt(query.get('page_size') ?? '20', 10) || 20));
  const rawSort = query.get('sort') || defaultSort;
  const field = rawSort.replace(/^-/, '');
  const sort = sortFields.includes(field) ? rawSort : defaultSort;
  return { page, pageSize, sort };
}

export function sortAndPage(items, { page, pageSize, sort }) {
  const descending = sort.startsWith('-');
  const field = sort.replace(/^-/, '');
  const sorted = [...items].sort((a, b) => {
    const left = a[field] ?? '';
    const right = b[field] ?? '';
    const order = typeof left === 'number' && typeof right === 'number' ? left - right : String(left).localeCompare(String(right));
    return descending ? -order : order;
  });
  return { items: sorted.slice((page - 1) * pageSize, page * pageSize), total: items.length, page, page_size: pageSize };
}

// --- Sector profiles (#71) ----------------------------------------------------------

const PROFILE_FIELDS = {
  business: {
    engagement_type: ['advisory', 'build', 'managed_service'],
    department: 120
  },
  education: {
    institution_type: ['school', 'college', 'university', 'training'],
    programme: 120,
    cohort: 60,
    academic_year: 20
  }
};

export const MILESTONE_TEMPLATES = {
  business: ['Discovery', 'Proposal', 'Build', 'User acceptance testing', 'Handover'],
  education: ['Needs analysis', 'Pilot cohort', 'Rollout', 'Term review']
};

export function validateSectorProfile(sector, profile, checker, field = 'sector_profile') {
  if (profile === undefined) return undefined;
  if (profile === null) return (checker.output[field] = null);
  if (typeof profile !== 'object' || Array.isArray(profile)) return checker.fail(field, 'Expected an object.');
  const allowed = PROFILE_FIELDS[sector];
  if (!allowed) return checker.fail(field, 'Choose the project sector first.');
  const output = {};
  for (const [key, value] of Object.entries(profile)) {
    const rule = allowed[key];
    if (!rule) {
      checker.fail(`${field}.${key}`, `Not a ${sector} field.`);
      continue;
    }
    if (value === null || value === '') continue;
    if (Array.isArray(rule)) {
      if (!rule.includes(value)) checker.fail(`${field}.${key}`, `Use one of: ${rule.join(', ')}.`);
      else output[key] = value;
    } else {
      output[key] = sanitizeText(value, rule);
    }
  }
  checker.output[field] = output;
  return output;
}

export function validateMilestones(value, checker, field = 'milestones') {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) return checker.fail(field, 'Expected a list.');
  if (value.length > 20) return checker.fail(field, 'Use at most 20 milestones.');
  const output = [];
  value.forEach((item, index) => {
    const title = sanitizeText(item?.title, 120);
    if (!title) {
      checker.fail(`${field}[${index}].title`, 'Enter a title.');
      return;
    }
    const due = item?.due ?? null;
    if (due !== null && (typeof due !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(due))) {
      checker.fail(`${field}[${index}].due`, 'Use the YYYY-MM-DD format.');
      return;
    }
    output.push({ title, due, done: item?.done === true });
  });
  checker.output[field] = output;
  return output;
}
