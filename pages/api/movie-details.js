import * as cheerio from 'cheerio';

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';

export default async function handler(req, res) {
  const { slug } = req.query;

  if (!slug) {
    return res.status(400).json({ error: 'Slug is required' });
  }

  try {
    // First, get the TMDB ID from Letterboxd page
    const tmdbId = await getTmdbIdFromLetterboxd(slug);

    if (!tmdbId) {
      return res.status(404).json({ error: 'Movie not found' });
    }

    // Fetch movie details from TMDB
    const details = await fetchTmdbDetails(tmdbId);

    return res.status(200).json(details);
  } catch (error) {
    console.error('Error fetching movie details:', error);
    return res.status(500).json({ error: 'Failed to fetch movie details' });
  }
}

async function getTmdbIdFromLetterboxd(slug) {
  try {
    const url = `https://letterboxd.com/film/${slug}/`;
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Look for data-tmdb-id on body tag (most reliable)
    const bodyTmdbId = $('body').attr('data-tmdb-id');
    if (bodyTmdbId) {
      return bodyTmdbId;
    }

    // Alternative: look for TMDB link in the page
    const tmdbLink = $('a[href*="themoviedb.org/movie/"]').attr('href');
    if (tmdbLink) {
      const match = tmdbLink.match(/themoviedb\.org\/movie\/(\d+)/);
      if (match) {
        return match[1];
      }
    }

    // Try finding it in script tags or meta
    const scripts = $('script').text();
    const tmdbMatch = scripts.match(/"tmdbId"\s*:\s*(\d+)/);
    if (tmdbMatch) {
      return tmdbMatch[1];
    }

    return null;
  } catch (error) {
    console.error('Error scraping Letterboxd:', error);
    return null;
  }
}

async function fetchTmdbDetails(tmdbId) {
  const url = `${TMDB_BASE}/movie/${tmdbId}?append_to_response=credits`;

  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TMDB_API_KEY}`,
      'Content-Type': 'application/json',
    },
  });

  if (!response.ok) {
    throw new Error('TMDB API request failed');
  }

  const data = await response.json();

  // Find director from credits
  const director =
    data.credits?.crew?.find((person) => person.job === 'Director')?.name ||
    'Unknown';

  return {
    title: data.title,
    year: data.release_date ? data.release_date.split('-')[0] : 'Unknown',
    runtime: data.runtime ? `${data.runtime} min` : 'Unknown',
    director,
    poster: data.poster_path
      ? `https://image.tmdb.org/t/p/w500${data.poster_path}`
      : null,
    backdrop: data.backdrop_path
      ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}`
      : null,
    tmdbId,
  };
}

