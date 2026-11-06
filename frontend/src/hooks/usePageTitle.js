import { useEffect } from 'react';

/** Sets the browser tab title (and optionally the description) for public pages. */
export function usePageTitle(title, description) {
  useEffect(() => {
    document.title = title ? `${title} · SHARKPOS` : 'SHARKPOS — Run your store smarter';
    if (description) {
      let m = document.querySelector('meta[name="description"]');
      if (!m) { m = document.createElement('meta'); m.name = 'description'; document.head.appendChild(m); }
      m.content = description;
    }
  }, [title, description]);
}
