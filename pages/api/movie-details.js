import * as cheerio from 'cheerio';

const TMDB_API_KEY = process.env.TMDB_API_KEY;
const TMDB_BASE = 'https://api.themoviedb.org/3';

export default async function handler(req, res) {
  // Ensure we always return JSON
  res.setHeader('Content-Type', 'application/json');

  const { title, slug } = req.query;

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

    // Fetch movie details from TMDB and Letterboxd in parallel
    const [tmdbDetails, letterboxdData] = await Promise.all([
      fetchTmdbDetails(tmdbId),
      slug ? fetchLetterboxdDetails(slug) : Promise.resolve(null),
    ]);

    // Merge the data
    const details = {
      ...tmdbDetails,
      description: letterboxdData?.description || tmdbDetails.description || null,
      letterboxdRating: letterboxdData?.rating || null,
    };

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
    description: data.overview || null,
    tmdbRating: data.vote_average ? parseFloat(data.vote_average.toFixed(1)) : null,
    poster: data.poster_path
      ? `https://image.tmdb.org/t/p/w500${data.poster_path}`
      : null,
    backdrop: data.backdrop_path
      ? `https://image.tmdb.org/t/p/w1280${data.backdrop_path}`
      : null,
    tmdbId,
  };
}

async function fetchLetterboxdDetails(slug) {
  try {
    const url = `https://letterboxd.com/film/${slug}/`;
    const response = await fetch(url, {
      headers: {
        'User-Agent':
          'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
      },
    });

    if (!response.ok) {
      return null;
    }

    const html = await response.text();
    const $ = cheerio.load(html);

    // Extract description - try multiple sources
    let description = null;
    
    // Method 1: Check meta description tag
    const metaDescription = $('meta[name="description"]').attr('content');
    if (metaDescription && !metaDescription.includes('Letterboxd') && metaDescription.length > 20) {
      description = metaDescription.trim();
    }
    
    // Method 2: Try to get from the film synopsis/description section
    if (!description) {
      const synopsis = $('div[class*="synopsis"]').first().text().trim() ||
                      $('div[class*="truncate"]').first().text().trim() ||
                      $('p[class*="text"]').first().text().trim();
      if (synopsis && synopsis.length > 20) {
        description = synopsis;
      }
    }

    // Method 3: Try structured data
    if (!description) {
      const scripts = $('script[type="application/ld+json"]');
      scripts.each((_, script) => {
        try {
          const jsonData = JSON.parse($(script).html());
          if (jsonData.description && jsonData.description.length > 20) {
            description = jsonData.description.trim();
            return false; // break
          }
        } catch (e) {
          // Ignore JSON parse errors
        }
      });
    }

    // Extract average rating - Letterboxd shows it in various places
    let rating = null;
    
    // Method 1: Check structured data (most reliable)
    const scripts = $('script[type="application/ld+json"]');
    scripts.each((_, script) => {
      try {
        const jsonData = JSON.parse($(script).html());
        if (jsonData.aggregateRating?.ratingValue) {
          rating = parseFloat(jsonData.aggregateRating.ratingValue);
          return false; // break
        }
      } catch (e) {
        // Ignore JSON parse errors
      }
    });

    // Method 2: Try to find in the stats section
    if (!rating) {
      const ratingText = $('meta[property="letterboxd:filmRating"]').attr('content') ||
                         $('span[class*="rating"]').first().text().trim() ||
                         $('div[class*="average-rating"]').first().text().trim();
      
      if (ratingText) {
        // Letterboxd ratings are out of 5, sometimes shown as "3.5" or "3.5/5"
        const ratingMatch = ratingText.match(/(\d+\.?\d*)/);
        if (ratingMatch) {
          const parsed = parseFloat(ratingMatch[1]);
          // Ensure it's a valid rating (0-5)
          if (parsed >= 0 && parsed <= 5) {
            rating = parsed;
          }
        }
      }
    }

    return {
      description: description || null,
      rating: rating ? parseFloat(rating.toFixed(1)) : null,
    };
  } catch (error) {
    console.error('Error fetching Letterboxd details:', error);
    return null;
  }
}
