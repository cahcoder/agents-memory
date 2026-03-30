#!/usr/bin/env python3
"""
memory_post_llm.py - POST-LLM hook: Analyze response + store learnings
Usage: memory_post_llm.py <user_input> <ai_response> [--project <name>]

Analyzes the AI response for new learnings and stores to Chroma.
"""

import sys
import json
import argparse
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "skill"))

from memory_write import memory_write


def detect_learning(user_input: str, ai_response: str) -> dict:
    """
    Analyze if AI response contains new learning worth storing.
    
    Returns:
        {
            "has_learning": bool,
            "type": "solution" | "fact" | "decision" | None,
            "problem": str,
            "solution": str,
            "logic": str,
            "confidence": float
        }
    """
    
    # Simple heuristic-based detection
    # In production, could use LLM to analyze
    
    learning_indicators = [
        "solved",
        "fixed",
        "the solution is",
        "here's how",
        "the answer is",
        "i recommend",
        "you can use",
        "run this command",
        "the problem was",
        "root cause",
        "this happens because",
        "pattern:",
        "best practice:",
        "decision:",
    ]
    
    response_lower = ai_response.lower()
    
    # Check if response contains learning indicators
    indicators_found = [ind for ind in learning_indicators if ind in response_lower]
    
    if not indicators_found:
        return {"has_learning": False}
    
    # Extract potential solution
    solution = ai_response
    
    # Determine type
    entry_type = "chat"  # default
    if any(w in response_lower for w in ["solved", "fixed", "the solution"]):
        entry_type = "solution"
    elif any(w in response_lower for w in ["decision:", "decided", "going with"]):
        entry_type = "decision"
    elif any(w in response_lower for w in ["root cause", "this happens because"]):
        entry_type = "fact"
    
    # Calculate confidence based on indicators found
    confidence = min(len(indicators_found) / 3, 1.0)  # 0.0 - 1.0
    
    return {
        "has_learning": True,
        "type": entry_type,
        "problem": user_input,
        "solution": solution[:2000],  # Limit size
        "logic": None,
        "confidence": confidence
    }


def memory_post_llm(user_input: str, ai_response: str, project: str = None):
    """
    POST-LLM hook:
    1. Analyze AI response for learnings
    2. If learning detected, store to Chroma
    3. Update use_count for referenced entries
    """
    
    learning = detect_learning(user_input, ai_response)
    
    if not learning.get("has_learning"):
        return {
            "stored": False,
            "reason": "No learning detected"
        }
    
    # Store the learning
    result = memory_write(
        problem=learning["problem"],
        solution=learning["solution"],
        logic_solution=learning.get("logic"),
        entry_type=learning["type"],
        project=project or "default",
        importance=learning["confidence"]
    )
    
    return {
        "stored": True,
        "entry_type": learning["type"],
        "result": result
    }


def main():
    parser = argparse.ArgumentParser(description="POST-LLM memory hook")
    parser.add_argument("input", help="User input (what was asked)")
    parser.add_argument("response", help="AI response (what was answered)")
    parser.add_argument("--project", "-p", help="Project name")
    
    args = parser.parse_args()
    
    result = memory_post_llm(args.input, args.response, args.project)
    
    print(json.dumps(result, indent=2, default=str))


if __name__ == "__main__":
    main()
