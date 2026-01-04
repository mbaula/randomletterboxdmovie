const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';

export default async function handler(req, res) {
  // Ensure we always return JSON
  res.setHeader('Content-Type', 'application/json');

  const { title } = req.query;

  if (!title) {
    return res.status(400).json({ error: 'Title is required' });
  }

  if (!TMDB_API_KEY) {
    return res.status(500).json({ error: 'TMDB API key not configured' });
  }

  try {
    // Search TMDB by title (primary method - no Letterboxd scraping)
    const tmdbId = await searchTmdbByTitle(title);

    if (!tmdbId) {
      return res.status(404).json({ error: 'Movie not found' });
    }

    // Fetch movie details from TMDB
    const details = await fetchTmdbDetails(tmdbId);

    return res.status(200).json(details);
  } catch (error) {
    console.error('Error fetching movie details:', error);
    const errorMessage =
      error instanceof Error ? error.message : 'Failed to fetch movie details';
    return res.status(500).json({ error: errorMessage });
  }
}

async function searchTmdbByTitle(title) {
  try {
    // Extract year if present in title like "Movie Name (1994)"
    const yearMatch = title.match(/\((\d{4})\)\s*$/);
    const year = yearMatch ? yearMatch[1] : null;
    const cleanTitle = title.replace(/\s*\(\d{4}\)\s*$/, '').trim();

    let url = `${TMDB_BASE}/search/movie?query=${encodeURIComponent(cleanTitle)}`;
    if (year) {
      url += `&year=${year}`;
    }

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${TMDB_API_KEY}`,
        'Content-Type': 'application/json',
      },
    });

    if (!response.ok) {
      return null;
    }

    const data = await response.json();

    if (data.results && data.results.length > 0) {
      // Return the first (most relevant) result
      return data.results[0].id.toString();
    }

    return null;
  } catch (error) {
    console.error('TMDB search failed:', error);
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
