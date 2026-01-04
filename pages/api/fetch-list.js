import * as cheerio from 'cheerio';
import { parseStringPromise } from 'xml2js';

export default async function handler(req, res) {
  // Ensure we always return JSON
  res.setHeader('Content-Type', 'application/json');

  const { url } = req.query;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }

  try {
    // Parse the Letterboxd list URL
    const listPath = extractListPath(url);
    if (!listPath) {
      return res.status(400).json({ error: 'Invalid Letterboxd list URL' });
    }

    // Try both methods and combine results
    const [rssFilms, scrapedFilms] = await Promise.all([
      tryRssFeed(listPath),
      scrapeAllPages(listPath),
    ]);

    // Prefer scraped results (more complete), fallback to RSS
    let films = [];
    if (scrapedFilms && scrapedFilms.length > 0) {
      films = scrapedFilms;
    } else if (rssFilms && rssFilms.length > 0) {
      films = rssFilms;
    }

    // Dedupe by Letterboxd slug
    const uniqueFilms = dedupeFilms(films);

    if (uniqueFilms.length === 0) {
      return res.status(404).json({ 
        error: 'Could not fetch list. The list may be private or temporarily unavailable.' 
      });
    }

    return res.status(200).json({ films: uniqueFilms });
  } catch (error) {
    console.error('Error fetching list:', error);
    const errorMessage =
      error instanceof Error ? error.message : 'Failed to fetch list';
    return res.status(500).json({ error: errorMessage });
  }
}

function extractListPath(url) {
  // Handle URLs like:
  // https://letterboxd.com/username/list/list-name/
  // https://letterboxd.com/username/list/list-name
  const match = url.match(/letterboxd\.com\/([^/]+)\/list\/([^/]+)/);
  if (match) {
    return `/${match[1]}/list/${match[2]}`;
  }
  return null;
}

async function fetchWithRetry(url, options, retries = 2) {
  for (let i = 0; i <= retries; i++) {
    try {
      const response = await fetch(url, options);
      if (response.ok) {
        return response;
      }
      // If we get a non-ok response, wait and retry
      if (i < retries) {
        await new Promise((r) => setTimeout(r, 500 * (i + 1)));
      }
    } catch (error) {
      if (i === retries) throw error;
      await new Promise((r) => setTimeout(r, 500 * (i + 1)));
    }
  }
  return null;
}

async function tryRssFeed(listPath) {
  try {
    const rssUrl = `https://letterboxd.com${listPath}/rss/`;
    const response = await fetchWithRetry(rssUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!response || !response.ok) {
      return null;
    }

    const text = await response.text();

    // Check if it's actually XML (not an HTML error page)
    if (!text.trim().startsWith('<?xml') && !text.trim().startsWith('<rss')) {
      return null;
    }

    const result = await parseStringPromise(text);

    if (!result.rss?.channel?.[0]?.item) {
      return null;
    }

    const films = result.rss.channel[0].item.map((item) => {
      const link = item.link?.[0] || '';
      const title = item['letterboxd:filmTitle']?.[0] || item.title?.[0] || '';
      const year = item['letterboxd:filmYear']?.[0] || '';
      const slug = link.match(/letterboxd\.com\/film\/([^/]+)/)?.[1] || '';

      // Format title with year if available
      const formattedTitle = year ? `${title} (${year})` : title;

      return {
        title: formattedTitle,
        year,
        slug,
        letterboxdUrl: link,
      };
    });

    return films.filter((f) => f.slug);
  } catch (error) {
    console.error('RSS feed failed:', error);
    return null;
  }
}

async function scrapeAllPages(listPath) {
  const films = [];
  let page = 1;
  let hasMore = true;
  let consecutiveFailures = 0;

  while (hasMore && consecutiveFailures < 2) {
    const pageUrl =
      page === 1
        ? `https://letterboxd.com${listPath}/`
        : `https://letterboxd.com${listPath}/page/${page}/`;

    try {
      const response = await fetchWithRetry(pageUrl, {
        headers: {
          'User-Agent':
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Cache-Control': 'no-cache',
        },
      });

      if (!response || !response.ok) {
        consecutiveFailures++;
        if (page === 1) {
          // If first page fails, break immediately
          break;
        }
        continue;
      }

      consecutiveFailures = 0; // Reset on success

      const html = await response.text();
      const $ = cheerio.load(html);

      // Letterboxd uses li.posteritem with data-item-slug on a react component div
      const filmElements = $('li.posteritem');

      if (filmElements.length === 0) {
        hasMore = false;
        break;
      }

      filmElements.each((_, el) => {
        const $el = $(el);
        // The slug is in data-item-slug on the react component div
        const $reactComponent = $el.find('div[data-item-slug]');
        const slug = $reactComponent.attr('data-item-slug') || '';
        const title = $reactComponent.attr('data-item-name') || '';

        if (slug && title) {
          films.push({
            title,
            year: '', // Will be extracted from title if present
            slug,
            letterboxdUrl: `https://letterboxd.com/film/${slug}/`,
          });
        }
      });

      // Check for next page - look for pagination link
      const hasNextPage = $('a.next').length > 0 || $('a[rel="next"]').length > 0;
      if (!hasNextPage) {
        hasMore = false;
      } else {
        page++;
      }

      // Safety limit
      if (page > 50) {
        hasMore = false;
      }
    } catch (error) {
      console.error(`Error scraping page ${page}:`, error);
      consecutiveFailures++;
      if (page === 1) {
        break;
      }
    }
  }

  return films;
}

function dedupeFilms(films) {
  const seen = new Set();
  return films.filter((film) => {
    if (seen.has(film.slug)) {
      return false;
    }
    seen.add(film.slug);
    return true;
  });
}
