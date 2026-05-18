import { useState, useCallback, useEffect, useRef } from 'react';
import { Link } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { use2048 } from '@/hooks/use2048';
import { GameBoard } from '@/components/game/GameBoard';
import { ScoreBox } from '@/components/game/ScoreBox';
import { WalletConnect } from '@/components/game/WalletConnect';
import { GameOverModal } from '@/components/game/GameOverModal';
import { PaymentModal, PaymentToken } from '@/components/game/PaymentModal';
import { Button } from '@/components/ui/button';
import { sendETHPayment, sendUSDCPayment } from '@/lib/blockchain';
import { hasSufficientBalance, refreshWalletBalances, validateActiveGameSession } from '@/lib/session-access';
import { RotateCcw, Lock, ArrowLeft, Trophy } from 'lucide-react';
import { toast } from 'sonner';
import type { Address } from 'viem';
import baseplayLogo from '@/assets/baseplay-logo.png';

const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL;
const GAME_FEE_USDC = '0.49';
const CREATOR_FEE_ETH = '0.0001';

const CREATOR_WALLETS = [
  '0xadf983e3d07d6abf344e1923f1d2164d8dffd816',
  '0xf79f164e634b76815b80b60a85e1258eb21d631c',
].map(addr => addr.toLowerCase());

const isCreatorWallet = (address: string | null) =>
  address && CREATOR_WALLETS.includes(address.toLowerCase());

type SessionStatus = 'checking' | 'locked' | 'active';

const Play2048 = () => {
  const { grid, score, gameOver, won, moveCount, move, resetGame } = use2048();
  const queryClient = useQueryClient();
  const submittedRef = useRef(false);

  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [showPayment, setShowPayment] = useState(false);
  const [balanceETH, setBalanceETH] = useState('0');
  const [balanceUSDC, setBalanceUSDC] = useState('0');
  const [isProcessing, setIsProcessing] = useState(false);
  const [sessionStatus, setSessionStatus] = useState<SessionStatus>('locked');
  const [dynamicEthFee, setDynamicEthFee] = useState<string | null>(null);
  const [ethPriceUsd, setEthPriceUsd] = useState<number | null>(null);
  const [scoreSaved, setScoreSaved] = useState(false);

  const isCreator = isCreatorWallet(walletAddress);
  const hasActiveSession = sessionStatus === 'active';
  const isCheckingSession = sessionStatus === 'checking';

  useEffect(() => {
    const fetchEthFee = async () => {
      try {
        const res = await fetch(`${SUPABASE_URL}/functions/v1/eth-price`);
        if (res.ok) {
          const data = await res.json();
          if (data.fee_eth) {
            setDynamicEthFee(data.fee_eth);
            setEthPriceUsd(data.eth_price_usd ?? null);
          }
        }
      } catch {
        setDynamicEthFee('0.00040000');
      }
    };
    fetchEthFee();
  }, []);

  const handleBalanceUpdate = useCallback((ethBal: string, usdcBal: string) => {
    setBalanceETH(ethBal);
    setBalanceUSDC(usdcBal);
  }, []);

  const syncBalances = useCallback(async (address: string) => {
    const balances = await refreshWalletBalances(address);
    setBalanceETH(balances.ethBalance);
    setBalanceUSDC(balances.usdcBalance);
    return balances;
  }, []);

  const validateSession = useCallback(async (address: string) => {
    setSessionStatus('checking');

    try {
      const result = await validateActiveGameSession(address, '2048');
      console.info('[2048] session validation', {
        walletAddress: address,
        sessionId: result.session_id,
        validationResult: result.valid,
      });

      if (result.valid && result.session_id) {
        setSessionId(result.session_id);
        setSessionStatus('active');
        return result;
      }

      setSessionId(null);
      setSessionStatus('locked');
      return result;
    } catch (error) {
      console.error('[2048] session validation failed', error);
      setSessionId(null);
      setSessionStatus('locked');
      return { valid: false, session_id: null, player_id: null, reason: null };
    }
  }, []);

  const handleWalletConnect = useCallback(async (address: string) => {
    setWalletAddress(address);
    await Promise.all([syncBalances(address), validateSession(address)]);
  }, [syncBalances, validateSession]);

  const handleWalletDisconnect = useCallback(() => {
    setWalletAddress(null);
    setSessionId(null);
    setBalanceETH('0');
    setBalanceUSDC('0');
    setSessionStatus('locked');
  }, []);

  useEffect(() => {
    if (!showPayment || !walletAddress) return;

    syncBalances(walletAddress).catch((error) => {
      console.error('[2048] failed to refresh balances before payment', error);
    });
  }, [showPayment, walletAddress, syncBalances]);

  // Safety: never leave the UI stuck in "processing" once the modal closes.
  useEffect(() => {
    if (!showPayment) setIsProcessing(false);
  }, [showPayment]);

  const startNewGame = useCallback(async (token: PaymentToken) => {
    if (!walletAddress) { toast.error('Please connect your wallet first'); return; }
    setIsProcessing(true);
    try {
      const isCreatorPayment = isCreator;
      const feeAmount = isCreatorPayment ? CREATOR_FEE_ETH : token === 'ETH' ? dynamicEthFee ?? '0.00040000' : GAME_FEE_USDC;
      const paymentToken = isCreatorPayment ? 'ETH' : token;
      const balances = await syncBalances(walletAddress);
      const availableBalance = paymentToken === 'ETH' ? balances.ethBalance : balances.usdcBalance;
      const validationResult = hasSufficientBalance(paymentToken, feeAmount, balances);

      console.info('[2048] pre-play balance check', {
        walletAddress,
        token: paymentToken,
        walletBalance: availableBalance,
        requiredFee: feeAmount,
        validationResult,
      });

      if (!validationResult) {
        toast.error('Insufficient balance to start a new session');
        return;
      }

      toast.info(isCreatorPayment
        ? `Creator verification: Sending ${feeAmount} ETH...`
        : `Sending ${feeAmount} ${paymentToken}... Please confirm in your wallet.`
      );

      let txHash: string;
      if (paymentToken === 'ETH') {
        txHash = await sendETHPayment(walletAddress as Address, feeAmount);
      } else {
        txHash = await sendUSDCPayment(walletAddress as Address, feeAmount);
      }

      toast.info('Payment confirmed! Creating game session...');

      const response = await fetch(`${SUPABASE_URL}/functions/v1/create-game-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          wallet_address: walletAddress,
          tx_hash: txHash,
          token_type: paymentToken,
          fee_amount: feeAmount,
          is_creator: isCreatorPayment,
          game_type: '2048',
        }),
      });

      const result = await response.json();
      if (!response.ok) throw new Error(result.error || 'Failed to create game session');

      setSessionId(result.session_id);
      setSessionStatus('active');
      setScoreSaved(false);
      resetGame();
      setShowPayment(false);
      console.info('[2048] session unlocked after payment', {
        walletAddress,
        txHash,
        sessionId: result.session_id,
      });
      toast.success(isCreatorPayment ? 'Creator verified! Game started!' : 'Game started! Good luck!');
    } catch (error: any) {
      console.error('Failed to start game:', error);
      const msg = String(error?.message || '').toLowerCase();
      if (msg.includes('rejected') || msg.includes('denied') || msg.includes('not authorized')) {
        toast.error('Transaction cancelled');
      } else {
        toast.error(error.message || 'Failed to process payment');
      }
    } finally {
      setIsProcessing(false);
    }
  }, [walletAddress, isCreator, dynamicEthFee, resetGame, syncBalances]);

  const handlePlayAgain = useCallback(() => {
    setScoreSaved(false);
    submittedRef.current = false;
    setSessionStatus('locked');
    setSessionId(null);
    if (walletAddress) setShowPayment(true);
    else resetGame();
  }, [walletAddress, resetGame]);

  const prevScoreRef = useRef(score);

  const handleGameEnd = useCallback(async () => {
    if (!sessionId || !walletAddress || submittedRef.current) return;
    submittedRef.current = true;
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/update-game-score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, wallet_address: walletAddress, score, end_game: true }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.ok) {
        setScoreSaved(true);
        toast.success('Score saved to leaderboard');
        queryClient.invalidateQueries({ queryKey: ['leaderboard'] });
      } else {
        submittedRef.current = false;
        toast.error(data?.error || 'Failed to save score');
      }
    } catch (error) {
      submittedRef.current = false;
      console.error('Failed to save score:', error);
      toast.error('Failed to save score');
    }
    setSessionStatus('locked');
  }, [sessionId, walletAddress, score, queryClient]);

  useEffect(() => {
    if (sessionId && walletAddress && hasActiveSession && score > prevScoreRef.current + 500) {
      prevScoreRef.current = score;
      fetch(`${SUPABASE_URL}/functions/v1/update-game-score`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, wallet_address: walletAddress, score, end_game: false }),
      }).catch(console.error);
    }
  }, [sessionId, walletAddress, hasActiveSession, score]);

  useEffect(() => {
    if ((gameOver || won) && sessionId && hasActiveSession) handleGameEnd();
  }, [gameOver, won, sessionId, hasActiveSession, handleGameEnd]);

  const needsWalletConnection = !walletAddress;
  const needsPayment = walletAddress && sessionStatus === 'locked';
  const isPlayBlocked = needsWalletConnection || isCheckingSession || !!needsPayment;

  return (
    <div className="min-h-screen bg-gradient-to-br from-primary/20 via-background to-secondary/30">
      <header className="py-4 px-4">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2 text-muted-foreground hover:text-foreground transition-colors">
            <ArrowLeft className="h-4 w-4" />
            <img src={baseplayLogo} alt="BasePlay" className="h-8 w-8" width={32} height={32} />
          </Link>
          <h1 className="text-3xl font-black gradient-title">2048</h1>
          <div className="flex items-center gap-2">
            <Link to="/leaderboard/2048">
              <Button variant="ghost" size="sm"><Trophy className="h-4 w-4" /></Button>
            </Link>
            <WalletConnect onConnect={handleWalletConnect} onDisconnect={handleWalletDisconnect} onBalanceUpdate={handleBalanceUpdate} />
          </div>
        </div>
      </header>

      <main className="px-4 pb-8">
        <div className="max-w-md mx-auto space-y-4">
          <div className="flex items-center justify-between">
            <ScoreBox label="Score" score={score} />
            {walletAddress && hasActiveSession && (
              <Button variant="outline" size="sm" onClick={() => setShowPayment(true)} className="gradient-primary text-primary-foreground border-none">
                <RotateCcw className="mr-1 h-4 w-4" /> New Game
              </Button>
            )}
          </div>

          <div className="relative">
            {isPlayBlocked && (
              <div className="absolute inset-0 bg-background/60 backdrop-blur-[2px] z-10 flex flex-col items-center justify-center rounded-xl">
                <Lock className="h-12 w-12 text-primary mb-4" />
                {isCheckingSession ? (
                  <>
                    <p className="text-lg font-semibold mb-2">Checking Session</p>
                    <p className="text-sm text-muted-foreground">Validating your latest paid session...</p>
                  </>
                ) : needsWalletConnection ? (
                  <>
                    <p className="text-lg font-semibold mb-2">Connect Wallet to Play</p>
                    <WalletConnect onConnect={handleWalletConnect} onDisconnect={handleWalletDisconnect} onBalanceUpdate={handleBalanceUpdate} />
                  </>
                ) : (
                  <>
                    <p className="text-lg font-semibold mb-2">New Session Required</p>
                    <p className="text-sm text-muted-foreground mb-4">You need to start a new session to play</p>
                    <Button onClick={() => setShowPayment(true)} className="gradient-gold text-accent-foreground">Pay Entry Fee</Button>
                  </>
                )}
              </div>
            )}
            <GameBoard grid={grid} onMove={move} disabled={isPlayBlocked} />
          </div>

          <p className="text-center text-muted-foreground text-sm">
            Use arrow keys or swipe to move tiles. Combine to reach 2048!
          </p>
          {moveCount > 0 && <p className="text-center text-muted-foreground text-xs">Moves: {moveCount}</p>}
        </div>
      </main>

      <GameOverModal isOpen={gameOver || (won && !gameOver)} score={score} won={won} onPlayAgain={handlePlayAgain} onClose={handlePlayAgain} scoreSaved={scoreSaved} />
      <PaymentModal
        isOpen={showPayment} onClose={() => setShowPayment(false)} onPay={startNewGame}
        feeETH={isCreator ? CREATOR_FEE_ETH : dynamicEthFee ?? '0.00040000'} feeUSDC={GAME_FEE_USDC}
        balanceETH={balanceETH} balanceUSDC={balanceUSDC} isLoading={isProcessing}
        isCreator={isCreator} ethPriceUsd={ethPriceUsd ?? undefined}
      />
    </div>
  );
};

export default Play2048;
