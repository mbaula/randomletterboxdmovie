import * as cheerio from 'cheerio';
import { parseStringPromise } from 'xml2js';

export default async function handler(req, res) {
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

    // Try RSS feed first
    let films = await tryRssFeed(listPath);

    // If RSS fails or returns empty, fall back to scraping
    if (!films || films.length === 0) {
      films = await scrapeList(listPath);
    }

    // Dedupe by Letterboxd slug
    const uniqueFilms = dedupeFilms(films);

    return res.status(200).json({ films: uniqueFilms });
  } catch (error) {
    console.error('Error fetching list:', error);
    return res.status(500).json({ error: 'Failed to fetch list' });
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

async function tryRssFeed(listPath) {
  try {
    const rssUrl = `https://letterboxd.com${listPath}/rss/`;
    const response = await fetch(rssUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'application/rss+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!response.ok) {
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

      return {
        title,
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

async function scrapeList(listPath) {
  const films = [];
  let page = 1;
  let hasMore = true;

  while (hasMore) {
    const pageUrl =
      page === 1
        ? `https://letterboxd.com${listPath}/`
        : `https://letterboxd.com${listPath}/page/${page}/`;

    const response = await fetch(pageUrl, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!response.ok) {
      break;
    }

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

      if (slug) {
        films.push({
          title,
          year: '', // Will be fetched from TMDB
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

