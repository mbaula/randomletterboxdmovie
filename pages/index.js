import { useState, useCallback, useRef } from 'react';
import Head from 'next/head';

// Get rating color class based on Letterboxd rating (out of 5)
const getRatingColorClass = (rating) => {
  if (rating >= 4.2) return 'rating-excellent';
  if (rating >= 3.5) return 'rating-great';
  if (rating >= 2.5) return 'rating-good';
  if (rating >= 1.8) return 'rating-mixed';
  return 'rating-poor';
};

// Get rating color class for TMDB (out of 10) - convert to same scale
const getTmdbRatingColorClass = (rating) => {
  const normalized = rating / 2; // Convert 10-scale to 5-scale
  return getRatingColorClass(normalized);
};

export default function Home() {
  const [url, setUrl] = useState('');
  const [films, setFilms] = useState([]);
  const [selectedMovie, setSelectedMovie] = useState(null);
  const [loading, setLoading] = useState(false);
  const [loadingMovie, setLoadingMovie] = useState(false);
  const [error, setError] = useState('');
  const [listLoaded, setListLoaded] = useState(false);

  // Cache: store fetched list and the URL it was fetched for
  const cache = useRef({ url: '', films: [] });

  const normalizeUrl = (inputUrl) => {
    // Normalize URL for comparison (trim, remove trailing slashes, lowercase)
    return inputUrl.trim().replace(/\/+$/, '').toLowerCase();
  };

  const fetchList = async () => {
    if (!url.trim()) {
      setError('Please enter a Letterboxd list URL');
      return;
    }

    if (!url.includes('letterboxd.com') || !url.includes('/list/')) {
      setError('Please enter a valid Letterboxd list URL');
      return;
    }

    const normalizedUrl = normalizeUrl(url);

    // Check cache - if same URL, just pick a new movie
    if (cache.current.url === normalizedUrl && cache.current.films.length > 0) {
      setFilms(cache.current.films);
      setListLoaded(true);
      setError('');
      setSelectedMovie(null);
      pickRandomMovie(cache.current.films);
      return;
    }

    setLoading(true);
    setError('');
    setSelectedMovie(null);
    setListLoaded(false);

    try {
      const response = await fetch(
        `/api/fetch-list?url=${encodeURIComponent(url)}`
      );

      let data;
      const contentType = response.headers.get('content-type');
      if (contentType && contentType.includes('application/json')) {
        data = await response.json();
      } else {
        const text = await response.text();
        throw new Error(
          response.ok
            ? 'Invalid response from server'
            : `Server error: ${text.substring(0, 100)}`
        );
      }

      if (!response.ok) {
        throw new Error(data.error || 'Failed to fetch list');
      }

      if (!data.films || data.films.length === 0) {
        throw new Error('No films found in this list');
      }

      // Update cache
      cache.current = { url: normalizedUrl, films: data.films };

      setFilms(data.films);
      setListLoaded(true);

      // Automatically pick a random movie
      pickRandomMovie(data.films);
    } catch (err) {
      setError(err.message || 'An error occurred while fetching the list');
      setFilms([]);
    } finally {
      setLoading(false);
    }
  };

  const pickRandomMovie = useCallback(
    async (filmList = films) => {
      if (filmList.length === 0) return;

      setLoadingMovie(true);
      setError('');

      const randomIndex = Math.floor(Math.random() * filmList.length);
      const randomFilm = filmList[randomIndex];

      try {
        // Use TMDB search by title and pass slug for Letterboxd data
        const params = new URLSearchParams({
          title: randomFilm.title || '',
          slug: randomFilm.slug || '',
        });
        const response = await fetch(`/api/movie-details?${params}`);

        let data;
        const contentType = response.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          data = await response.json();
        } else {
          const text = await response.text();
          throw new Error(
            response.ok
              ? 'Invalid response from server'
              : `Server error: ${text.substring(0, 100)}`
          );
        }

        if (!response.ok) {
          throw new Error(data.error || 'Failed to fetch movie details');
        }

        setSelectedMovie({
          ...data,
          slug: randomFilm.slug,
          letterboxdUrl: randomFilm.letterboxdUrl,
        });
      } catch (err) {
        setError(err.message || 'An error occurred while fetching movie details');
      } finally {
        setLoadingMovie(false);
      }
    },
    [films]
  );

  const handleSubmit = (e) => {
    e.preventDefault();
    fetchList();
  };

  const handleKeyDown = (e) => {
    if (e.key === 'Enter') {
      fetchList();
    }
  };

  return (
    <>
      <Head>
        <title>Random Letterboxd Movie</title>
        <meta
          name="description"
          content="Pick a random movie from any Letterboxd list"
        />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <link rel="icon" href="/favicon.ico" />
      </Head>

      <div className="container">
        <header>
          <h1>Random Letterboxd Movie</h1>
          <p>Paste a public list URL and discover your next watch</p>
        </header>

        <main>
          <section className="input-section">
            <form onSubmit={handleSubmit}>
              <div className="input-wrapper">
                <input
                  type="text"
                  value={url}
                  onChange={(e) => setUrl(e.target.value)}
                  onKeyDown={handleKeyDown}
                  placeholder="https://letterboxd.com/username/list/list-name/"
                  disabled={loading}
                />
                <button type="submit" disabled={loading}>
                  {loading ? 'Loading...' : 'Fetch List'}
                </button>
              </div>
            </form>

            {error && <div className="error-message">{error}</div>}
          </section>

          {loading && (
            <div className="loading">
              <div className="spinner" />
              <span>Fetching list...</span>
            </div>
          )}

          {listLoaded && !loading && (
            <>
              <div className="list-info">
                <span>
                  Found <strong>{films.length}</strong> films in this list
                </span>
                <button
                  className="pick-button"
                  onClick={() => pickRandomMovie()}
                  disabled={loadingMovie}
                >
                  {loadingMovie ? 'Picking...' : 'Pick Another'}
                </button>
              </div>

              {loadingMovie && (
                <div className="loading">
                  <div className="spinner" />
                  <span>Loading movie details...</span>
                </div>
              )}

              {selectedMovie && !loadingMovie && (
                <article className="movie-card">
                  <div className="movie-content">
                    <div className="poster-container">
                      {selectedMovie.poster ? (
                        <img
                          src={selectedMovie.poster}
                          alt={`${selectedMovie.title} poster`}
                          className="poster"
                        />
                      ) : (
                        <div className="poster-placeholder">No poster</div>
                      )}
                    </div>
                    <div className="movie-info">
                      <h2 className="movie-title">
                        {selectedMovie.title}
                        <span className="movie-year">
                          {' '}
                          ({selectedMovie.year})
                        </span>
                      </h2>
                      <div className="movie-meta">
                        <div className="meta-item">
                          <span className="meta-label">Director</span>
                          <span className="meta-value">
                            {selectedMovie.director}
                          </span>
                        </div>
                        <div className="meta-item">
                          <span className="meta-label">Runtime</span>
                          <span className="meta-value">
                            {selectedMovie.runtime}
                          </span>
                        </div>
                        {(selectedMovie.letterboxdRating || selectedMovie.tmdbRating) && (
                          <div className="meta-item">
                            <span className="meta-label">Ratings</span>
                            <span className="meta-value ratings">
                              {selectedMovie.letterboxdRating && (
                                <span className="rating">
                                  <span className="rating-label">Letterboxd:</span>
                                  <span className={`rating-value ${getRatingColorClass(selectedMovie.letterboxdRating)}`}>
                                    {selectedMovie.letterboxdRating}/5
                                  </span>
                                </span>
                              )}
                              {selectedMovie.letterboxdRating && selectedMovie.tmdbRating && (
                                <span className="rating-separator"> • </span>
                              )}
                              {selectedMovie.tmdbRating && (
                                <span className="rating">
                                  <span className="rating-label">TMDB:</span>
                                  <span className={`rating-value ${getTmdbRatingColorClass(selectedMovie.tmdbRating)}`}>
                                    {selectedMovie.tmdbRating}/10
                                  </span>
                                </span>
                              )}
                            </span>
                          </div>
                        )}
                      </div>
                      {selectedMovie.description && (
                        <div className="movie-description">
                          <p>{selectedMovie.description}</p>
                        </div>
                      )}
                      <div className="movie-actions">
                        <a
                          href={`https://letterboxd.com/film/${selectedMovie.slug}/`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          View on Letterboxd
                        </a>
                        <a
                          href={`https://www.themoviedb.org/movie/${selectedMovie.tmdbId}`}
                          target="_blank"
                          rel="noopener noreferrer"
                        >
                          View on TMDB
                        </a>
                      </div>
                    </div>
                  </div>
                </article>
              )}
            </>
          )}
        </main>

        <footer>
          <p>
            Data from <a href="https://letterboxd.com">Letterboxd</a> &{' '}
            <a href="https://themoviedb.org">TMDB</a>
          </p>
        </footer>
      </div>
    </>
  );
}
