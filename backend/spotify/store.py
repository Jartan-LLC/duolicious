"""
The write paths for a person's Spotify connection. The OAuth callback
creates the connection via `store_spotify_connection`; the refresh cron goes
through `update_spotify_connection`, which is update-only so a refresh in
flight while the person disconnects (or is revoked) can't resurrect the
connection. Both replace tokens and artists in the caller's one transaction,
so they can never drift out of step with each other.
"""

from database import Tx
from spotify import SpotifyArtist, SpotifyTokens
from spotify.sql import (
    Q_DELETE_PERSON_SPOTIFY_ARTISTS,
    Q_INSERT_PERSON_SPOTIFY_ARTISTS,
    Q_MARK_SPOTIFY_ARTISTS_SYNCED,
    Q_TOUCH_PERSON_SPOTIFY,
    Q_UPDATE_PERSON_SPOTIFY,
    Q_UPSERT_PERSON_SPOTIFY,
    Q_UPSERT_SPOTIFY_ARTISTS,
)


async def store_spotify_connection(
    tx: Tx,
    person_id: int,
    tokens: SpotifyTokens,
    artists: list[SpotifyArtist] | None,
) -> None:
    """Create (or replace) the connection and, when `artists` is not None,
    replace the person's artist list. `artists=None` means the fetch failed;
    the stored tokens let the cron backfill later."""
    await tx.execute(Q_UPSERT_PERSON_SPOTIFY, dict(
        person_id=person_id,
        access_token=tokens.access_token,
        expires_in=tokens.expires_in,
        refresh_token=tokens.refresh_token,
    ))

    if artists is not None:
        await _replace_artists(tx, person_id, artists)


async def update_spotify_connection(
    tx: Tx,
    person_id: int,
    tokens: SpotifyTokens | None,
    artists: list[SpotifyArtist] | None,
) -> bool:
    """Update `tokens` (or just bump `refreshed_at` when None, so the cron
    queue rotates) and, when `artists` is not None, replace the person's
    artist list. Returns False without writing anything when the person no
    longer has a connection."""
    if tokens is not None:
        cur = await tx.execute(Q_UPDATE_PERSON_SPOTIFY, dict(
            person_id=person_id,
            access_token=tokens.access_token,
            expires_in=tokens.expires_in,
            refresh_token=tokens.refresh_token,
        ))
    else:
        cur = await tx.execute(Q_TOUCH_PERSON_SPOTIFY, dict(
            person_id=person_id,
        ))

    if await cur.fetchone() is None:
        return False

    if artists is not None:
        await _replace_artists(tx, person_id, artists)

    return True


async def _replace_artists(
    tx: Tx,
    person_id: int,
    artists: list[SpotifyArtist],
) -> None:
    # Upsert the shared catalog in canonical (sorted) order so concurrent
    # transactions covering overlapping artists can't deadlock. The upsert
    # also row-locks every artist this transaction is about to reference,
    # which is what stops the garbage-records prune of unreferenced catalog
    # rows from deleting them out from under the inserts below.
    await tx.executemany(Q_UPSERT_SPOTIFY_ARTISTS, params_seq=[
        dict(
            spotify_artist_id=artist.spotify_id,
            name=artist.name,
            image_url_small=artist.image_url_small,
            image_url_large=artist.image_url_large,
        )
        for artist in sorted(artists, key=lambda artist: artist.spotify_id)
    ])

    await tx.execute(Q_DELETE_PERSON_SPOTIFY_ARTISTS, dict(
        person_id=person_id,
    ))

    await tx.executemany(Q_INSERT_PERSON_SPOTIFY_ARTISTS, params_seq=[
        dict(
            person_id=person_id,
            spotify_artist_id=artist.spotify_id,
            position=position,
        )
        for position, artist in enumerate(artists)
    ])

    await tx.execute(Q_MARK_SPOTIFY_ARTISTS_SYNCED, dict(
        person_id=person_id,
    ))
