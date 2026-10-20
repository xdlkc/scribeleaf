// Custom find/replace panel styled like Typora's find bar.

import { EditorView, Panel } from '@codemirror/view';
import {
  SearchQuery,
  setSearchQuery,
  findNext,
  findPrevious,
  replaceNext,
  replaceAll,
  openSearchPanel,
  closeSearchPanel,
  getSearchQuery,
} from '@codemirror/search';

let panelDom: HTMLElement | null = null;
let replaceRow: HTMLElement | null = null;

export function createSearchPanel(view: EditorView): Panel {
  const dom = document.createElement('div');
  dom.className = 'cm-find-panel';

  const findRow = document.createElement('div');
  findRow.className = 'cm-find-row';

  const toggle = document.createElement('button');
  toggle.className = 'cm-find-toggle';
  toggle.title = 'Toggle Replace';
  toggle.textContent = '›';

  const findInput = document.createElement('input');
  findInput.className = 'cm-find-input';
  findInput.placeholder = 'Find';
  findInput.setAttribute('aria-label', 'Find');

  const count = document.createElement('span');
  count.className = 'cm-find-count';

  const prevBtn = btn('‹', 'Find Previous (⇧Enter)');
  const nextBtn = btn('›', 'Find Next (Enter)');
  const caseBtn = btn('Aa', 'Match Case');
  caseBtn.classList.add('cm-find-case');
  const closeBtn = btn('✕', 'Close (Esc)');

  findRow.append(toggle, findInput, count, prevBtn, nextBtn, caseBtn, closeBtn);

  const replace = document.createElement('div');
  replace.className = 'cm-find-row cm-replace-row';
  const replaceInput = document.createElement('input');
  replaceInput.className = 'cm-find-input';
  replaceInput.placeholder = 'Replace';
  replaceInput.setAttribute('aria-label', 'Replace');
  const replaceBtn = btn('Replace', 'Replace current');
  const replaceAllBtn = btn('All', 'Replace all');
  replace.append(replaceInput, replaceBtn, replaceAllBtn);
  replace.style.display = 'none';
  replaceRow = replace;

  dom.append(findRow, replace);
  panelDom = dom;

  function currentQuery(): SearchQuery {
    return new SearchQuery({
      search: findInput.value,
      replace: replaceInput.value,
      caseSensitive: caseBtn.classList.contains('active'),
    });
  }

  function commit(): void {
    view.dispatch({ effects: setSearchQuery.of(currentQuery()) });
  }

  function updateCount(): void {
    const q = getSearchQuery(view.state);
    if (!q.valid || !q.search) {
      count.textContent = '';
      return;
    }
    let n = 0;
    let current = 0;
    const selFrom = view.state.selection.main.from;
    try {
      const cursor = q.getCursor(view.state);
      let m = cursor.next();
      while (!m.done) {
        n++;
        if (current === 0 && m.value.from <= selFrom && selFrom <= m.value.to) current = n;
        if (n >= 9999) break;
        m = cursor.next();
      }
    } catch {
      count.textContent = '';
      return;
    }
    if (current === 0) {
      // selection not inside a match: count matches before selection
      current = 0;
      try {
        const cursor = q.getCursor(view.state);
        let m = cursor.next();
        while (!m.done && m.value.from < selFrom) {
          current++;
          m = cursor.next();
        }
        if (current < n) current += 1;
      } catch {
        /* keep */
      }
    }
    count.textContent = n === 0 ? 'No results' : `${Math.min(current, n)}/${n}`;
  }

  findInput.addEventListener('input', () => {
    commit();
    updateCount();
  });
  replaceInput.addEventListener('input', commit);
  caseBtn.addEventListener('click', () => {
    caseBtn.classList.toggle('active');
    commit();
    updateCount();
    findInput.focus();
  });
  nextBtn.addEventListener('click', () => findNext(view));
  prevBtn.addEventListener('click', () => findPrevious(view));
  replaceBtn.addEventListener('click', () => {
    replaceNext(view);
    updateCount();
  });
  replaceAllBtn.addEventListener('click', () => {
    replaceAll(view);
    updateCount();
  });
  closeBtn.addEventListener('click', () => {
    closeSearchPanel(view);
    view.focus();
  });
  toggle.addEventListener('click', () => {
    setReplaceVisible(replace.style.display === 'none');
    findInput.focus();
  });

  const onKey = (e: KeyboardEvent) => {
    if (e.isComposing) return; // IME: Enter confirms composition
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault();
      findPrevious(view);
    } else if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      replaceNext(view);
      updateCount();
    } else if (e.key === 'Enter') {
      e.preventDefault();
      findNext(view);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      closeSearchPanel(view);
      view.focus();
    }
  };
  findInput.addEventListener('keydown', onKey);
  replaceInput.addEventListener('keydown', onKey);

  function setReplaceVisible(visible: boolean): void {
    replace.style.display = visible ? '' : 'none';
    toggle.classList.toggle('open', visible);
  }

  return {
    dom,
    top: true,
    mount() {
      // prefill from current selection / existing query
      const q = getSearchQuery(view.state);
      if (q.valid && q.search) {
        findInput.value = q.search;
        replaceInput.value = q.replace;
        caseBtn.classList.toggle('active', q.caseSensitive);
      } else {
        const sel = view.state.selection.main;
        if (!sel.empty) {
          const text = view.state.sliceDoc(sel.from, sel.to);
          if (!text.includes('\n') && text.length <= 200) findInput.value = text;
        }
      }
      // dispatching is not allowed during a view update — defer
      setTimeout(() => {
        commit();
        updateCount();
        findInput.focus();
        findInput.select();
      }, 0);
    },
    update() {
      updateCount();
    },
    destroy() {
      panelDom = null;
      replaceRow = null;
    },
  };
}

function btn(label: string, title: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.textContent = label;
  b.title = title;
  b.className = 'cm-find-btn';
  return b;
}

/** Open the find bar, optionally expanded to replace mode. */
export function openFind(view: EditorView, replaceMode: boolean): void {
  openSearchPanel(view);
  if (replaceRow) {
    replaceRow.style.display = replaceMode ? '' : 'none';
    panelDom?.querySelector('.cm-find-toggle')?.classList.toggle('open', replaceMode);
    const input = panelDom?.querySelector<HTMLInputElement>(replaceMode ? '.cm-replace-row .cm-find-input' : '.cm-find-input');
    input?.focus();
    input?.select();
  }
}

export function closeFind(view: EditorView): void {
  closeSearchPanel(view);
}
