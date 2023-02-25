import {
  Room,
  Client,
  Delayed,
  Protocol,
  ServerError,
  ErrorCode,
} from 'colyseus';
import { GameState, Player } from './schema/GameState';
import { uniqueNamesGenerator, colors, animals } from 'unique-names-generator';
import gameConfig from '../game.config';
import log from 'npmlog';

export class GameRoom extends Room<GameState> {
  /** Current timeout skip reference */
  private inactivityTimeoutRef: Delayed;

  /** Iterator for all players that are playing in the current round */
  private roundPlayersIdIterator: IterableIterator<string>;

  private delayedRoundStartRef: Delayed;

  public autoDispose = false;

  private LOBBY_CHANNEL = 'GameRoom';

  private log(msg: string, client?: Client | string) {
    log.info(
      `Room ${this.roomId} ${
        client ? 'Client ' + ((<any>client).sessionId || client) : ''
      }`,
      msg
    );
  }

  private generateRoomIdString(): string {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ';
    let result = '';
    for (let i = 0; i < gameConfig.roomIdLength; i++)
      result += chars.charAt(Math.floor(Math.random() * chars.length));
    return result;
  }

  private async generateRoomId(): Promise<string> {
    const currentIds = await this.presence.smembers(this.LOBBY_CHANNEL);
    let id;

    do id = this.generateRoomIdString();
    while (currentIds.includes(id));

    await this.presence.sadd(this.LOBBY_CHANNEL, id);
    return id;
  }

  private delay(ms: number) {
    return new Promise((resolve) => this.clock.setTimeout(resolve, ms));
  }

  async onCreate() {
    this.roomId = await this.generateRoomId();
    this.setPrivate();
    this.setState(new GameState({}));
    this.clock.start();

    this.log('Created');

    this.onMessage('ready', (client, state: boolean) => {
      //Cant change ready state during round
      if (this.state.roundState != 'idle') return;

      this.log(`Ready state change: ${state}`, client);

      this.state.players.get(client.sessionId).ready = state;
      this.triggerNewRoundCheck();
    });

    this.onMessage('autoReady', (client, state: boolean) => {
      if (this.state.roundState != 'idle') return;

      this.log(`Auto ready state change: ${state}`, client);

      const player = this.state.players.get(client.sessionId);
      player.ready = player.autoReady = state;
      this.triggerNewRoundCheck();
    });

    this.onMessage('bet', (client, newBet: number) => {
      if (
        this.state.roundState != 'idle' || //Cant change bet during round
        this.state.players.get(client.sessionId).ready || //Cant change bet when ready
        !Number.isInteger(newBet) // new bet is invalid
      )
        return;

      //Constrain bet
      newBet = Math.min(Math.max(newBet, gameConfig.minBet), gameConfig.maxBet);

      this.log(`Bet change: ${newBet}`, client);

      this.state.players.get(client.sessionId).bet = newBet;
    });

    this.onMessage('hit', (client) => {
      if (client.sessionId != this.state.currentTurnPlayerId) return;

      this.log(`Hit`, client);

      const player = this.state.players.get(client.sessionId);

      player.hand.addCard();

      if (player.hand.isBusted) {
        //Making player not ready basically kicks them from the current round
        player.ready = false;
        player.roundOutcome = 'bust';
        this.turn();
      } else if (player.hand.score == 21) {
        //Player can't hit anymore, go to next player
        this.turn();
      } else {
        //Player can still hit, Reset skip timer
        this.setInactivitySkipTimeout();
      }
    });

    this.onMessage('stay', (client) => {
      if (client.sessionId != this.state.currentTurnPlayerId) return;

      this.log(`Stay`, client);

      this.turn();
    });

    this.onMessage('kick', (client, id: string) => {
      if (!this.state.players.get(client.sessionId)?.admin || !id) return;

      this.log(`Kick client ${id}`, client);

      this.clients
        .find((c) => c.sessionId == id)
        .leave(Protocol.WS_CLOSE_CONSENTED);
    });
  }

  async onAuth(client: Client) {
    //No more space at table
    if (this.state.players.size == gameConfig.maxClients)
      throw new ServerError(gameConfig.roomFullCode, 'room is full');

    //We have to kick the oldest disconnected player to make space for new player
    if (
      this.state.players.size + Object.keys(this.reconnections).length ==
      gameConfig.maxClients
    ) {
      Object.values(this.reconnections)[0].reject();
    }

    return true;
  }

  onJoin(client: Client) {
    this.log(`Join`, client);

    this.state.players.set(
      client.sessionId,
      new Player({
        sessionId: client.sessionId,
        displayName: uniqueNamesGenerator({
          dictionaries: [colors, animals],
          separator: ' ',
          style: 'capital',
        }),
        admin: this.state.players.size == 0,
      })
    );
    this.triggerNewRoundCheck();
  }

  async onLeave(client: Client, consented: boolean) {
    this.log(`Leave`, client);

    const player = this.state.players.get(client.sessionId);
    player.disconnected = true;

    //Remove player if leave was consented or if they are not in round
    if (consented || !(this.state.roundState != 'idle' && player.ready)) {
      this.deletePlayer(client.sessionId);
    }

    //Do not allow for rejoin if leave was consented
    if (consented) return;

    //Add player back if they rejoin
    try {
      this.log(`Allow reconnection`, client);

      await this.allowReconnection(client);

      this.log(`Reconnect`, client);

      player.disconnected = false;

      //Add player back if they were removed earlier
      if (!this.state.players.has(client.sessionId)) {
        this.state.players.set(client.sessionId, player.clone());
        this.triggerNewRoundCheck();
      }
    } catch (error) {}
  }

  onDispose() {
    this.presence.srem(this.LOBBY_CHANNEL, this.roomId);
    this.log(`Disposing`);
  }

  /** Automatically starts round if:
   * - There is no round currently
   * - All players are ready
   */
  private triggerNewRoundCheck() {
    if (this.state.roundState != 'idle') return;

    //Clear previous start
    this.state.nextRoundStartTimestamp = 0;
    this.delayedRoundStartRef?.clear();

    const playerArr = [...this.state.players.values()];

    //If there are no players left or not all players are ready, do not start round
    if (playerArr.length == 0 || playerArr.some((p) => !p.ready)) return;

    this.log(`Setting delayed round start`);

    this.state.nextRoundStartTimestamp =
      Date.now() + gameConfig.delayedRoundStartTime;
    this.delayedRoundStartRef = this.clock.setTimeout(() => {
      this.state.nextRoundStartTimestamp = 0;
      this.startRound();
    }, gameConfig.delayedRoundStartTime);
  }

  private deletePlayer(id: string) {
    const player = this.state.players.get(id);
    this.state.players.delete(id);

    // Dispose room if there are no more players left
    if (this.state.players.size == 0) {
      this.disconnect();
      return;
    }

    //If deleted player was admin, assign random other player as admin
    if (player.admin) {
      player.admin = false;

      const a = [...this.state.players.values()];
      a[Math.floor(Math.random() * a.length)].admin = true;
    }

    this.triggerNewRoundCheck();

    //If player that was removed was the currently playing player, skip them
    if (id == this.state.currentTurnPlayerId) this.turn();
  }

  /** Iterator over players that only takes ready players into account */
  private *makeRoundIterator() {
    const playerIterator = this.state.players.entries();

    while (true) {
      const newPlayer = playerIterator.next();

      //Finish this iterator when base iterator finishes
      if (newPlayer.done) return;

      //If grabbed player is not ready, go to next player
      if (!newPlayer.value[1].ready) continue;

      //Otherwise yield the new player id
      yield newPlayer.value[0] as string;
    }
  }

  private async startRound() {
    this.log(`Starting dealing phase`);

    this.state.roundState = 'dealing';

    for (const playerId of this.makeRoundIterator()) {
      const player = this.state.players.get(playerId);

      //Take money for bet from player account
      player.money -= player.bet;

      //Deal player cards
      player.hand.clear();
      player.hand.addCard();
      player.hand.addCard();
    }

    //Deal dealer cards
    this.state.dealerHand.clear();
    this.state.dealerHand.addCard();
    this.state.dealerHand.addCard(false);

    //Delay starting next phase
    await this.delay(gameConfig.roundStateDealingTime);

    this.log(`Starting turns phase`);

    this.state.roundState = 'turns';

    //Setup iterator for turns
    this.roundPlayersIdIterator = this.makeRoundIterator();

    this.turn();
  }

  private turn() {
    // New turn, do not skip player from previous turn
    this.state.currentTurnTimeoutTimestamp = 0;
    this.inactivityTimeoutRef?.clear();

    // Get next player
    const nextPlayer = this.roundPlayersIdIterator.next();
    this.state.currentTurnPlayerId = nextPlayer.value || '';

    // If there are no more players, end current round
    if (nextPlayer.done) {
      this.endRound();
      return;
    }

    this.log('Turn', this.state.currentTurnPlayerId);

    //Skip round if player has blackjack
    if (this.state.players.get(this.state.currentTurnPlayerId).hand.score == 21)
      this.turn();
    else this.setInactivitySkipTimeout();
  }

  private setInactivitySkipTimeout() {
    this.state.currentTurnTimeoutTimestamp =
      Date.now() + gameConfig.inactivityTimeout;

    this.inactivityTimeoutRef?.clear();

    this.inactivityTimeoutRef = this.clock.setTimeout(() => {
      this.log('Inactivity timeout', this.state.currentTurnPlayerId);
      this.turn();
    }, gameConfig.inactivityTimeout);
  }

  private async endRound() {
    this.log(`Starting end phase`);

    this.state.roundState = 'end';

    //Show dealers hidden card
    this.state.dealerHand.cards.at(1).visible = true;

    //Calculate hand value after showing hidden card
    this.state.dealerHand.calculateScore();

    //Do not deal dealer cards if all players are busted
    if (!this.makeRoundIterator().next().done) {
      //Dealer draws cards until total is at least 17
      while (this.state.dealerHand.score < 17) {
        await this.delay(gameConfig.dealerCardDelay);
        this.state.dealerHand.addCard();
      }

      //Delay showing round outcome to players
      await this.delay(gameConfig.roundOutcomeDelay);

      //Settle score between each player that's not busted, and dealer
      for (const playerId of this.makeRoundIterator()) {
        const player = this.state.players.get(playerId);

        if (player.hand.isBlackjack && !this.state.dealerHand.isBlackjack) {
          // Player wins 3:2
          player.money += (5 / 2) * player.bet;
          player.roundOutcome = 'win';
        } else if (
          this.state.dealerHand.isBusted || //dealer busted, player wins
          player.hand.score > this.state.dealerHand.score // player has higher score than dealer, player wins
        ) {
          player.money += player.bet * 2;
          player.roundOutcome = 'win';
        } else if (
          player.hand.score == this.state.dealerHand.score && //Score is the same
          player.hand.isBlackjack == this.state.dealerHand.isBlackjack //And dealer does not have blackjack if player also doesn't have it
        ) {
          player.money += player.bet;
          player.roundOutcome = 'draw';
        } else {
          player.roundOutcome = 'lose';
        }
      }
    }

    //Delay starting next phase
    await this.delay(
      gameConfig.roundStateEndTimeBase +
        this.state.players.size * gameConfig.roundStateEndTimePlayer
    );

    //Remove dealer cards
    this.state.dealerHand.clear();

    //Remove all players cards, and set their ready state
    for (const player of this.state.players.values()) {
      player.hand.clear();
      player.ready = false;
      player.roundOutcome = '';

      //Remove players that are still disconnected
      if (player.disconnected) this.deletePlayer(player.sessionId);
      //And for others, set their ready state
      else player.ready = player.autoReady;
    }

    this.log(`Starting idle phase`);
    this.state.roundState = 'idle';
    this.triggerNewRoundCheck();
  }
}
