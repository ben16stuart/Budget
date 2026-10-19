"""Request bodies. Amounts are integer cents."""

from __future__ import annotations

import datetime as dt
from datetime import date
from typing import Literal, Optional

from pydantic import BaseModel, Field, field_validator, model_validator

AccountType = Literal["checking", "savings", "credit_card", "cash", "investment", "other"]
Kind = Literal["credit", "debit", "transfer"]
Frequency = Literal["once", "day", "week", "month", "year"]
Status = Literal["scheduled", "paid", "skipped"]


def _clean(value: Optional[str]) -> Optional[str]:
    if value is None:
        return None
    value = value.strip()
    return value or None


class AccountIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    type: AccountType = "checking"
    opening_balance: int = 0
    opening_date: date
    min_balance: Optional[int] = None
    color: Optional[str] = Field(default=None, max_length=20)
    notes: Optional[str] = Field(default=None, max_length=2000)

    @field_validator("name", mode="before")
    @classmethod
    def _strip_name(cls, v):
        return v.strip() if isinstance(v, str) else v

    @field_validator("color", "notes", mode="before")
    @classmethod
    def _clean_text(cls, v):
        return _clean(v) if isinstance(v, str) else v


class EntryIn(BaseModel):
    name: str = Field(min_length=1, max_length=100)
    kind: Kind
    account_id: int
    to_account_id: Optional[int] = None
    amount: Optional[int] = Field(default=None, ge=0)
    variable: bool = False
    estimate: Optional[int] = Field(default=None, ge=0)
    frequency: Frequency = "once"
    interval: int = Field(default=1, ge=1, le=366)
    start_date: date
    end_date: Optional[date] = None
    autopay: bool = False
    remind_days: int = Field(default=5, ge=0, le=60)
    category: Optional[str] = Field(default=None, max_length=50)
    notes: Optional[str] = Field(default=None, max_length=2000)

    @field_validator("name", mode="before")
    @classmethod
    def _strip_name(cls, v):
        return v.strip() if isinstance(v, str) else v

    @field_validator("category", "notes", mode="before")
    @classmethod
    def _clean_text(cls, v):
        return _clean(v) if isinstance(v, str) else v

    @model_validator(mode="after")
    def _check(self):
        if self.kind == "transfer":
            if self.to_account_id is None:
                raise ValueError("A transfer needs a destination account")
            if self.to_account_id == self.account_id:
                raise ValueError("A transfer needs two different accounts")
        else:
            self.to_account_id = None
        if self.variable:
            self.amount = None
        elif self.amount is None:
            raise ValueError("Enter an amount, or mark the amount as varying")
        else:
            self.estimate = None
        if self.frequency == "once":
            self.end_date = None
            self.interval = 1
        if self.end_date is not None and self.end_date < self.start_date:
            raise ValueError("The end date is before the first date")
        if self.kind == "credit":
            self.autopay = False
        return self


class EntryUpdate(EntryIn):
    # When set on a recurring entry, occurrences before this date keep the old
    # details and the changes apply from this date on (the series is split).
    effective_from: Optional[date] = None


class OccurrencePatch(BaseModel):
    """Only the fields present in the request are changed; null clears an override."""

    amount: Optional[int] = Field(default=None, ge=0)
    date: Optional[dt.date] = None  # dt.date: the field name shadows the type
    status: Optional[Status] = None
    note: Optional[str] = Field(default=None, max_length=2000)


class SettingsIn(BaseModel):
    currency: Optional[str] = Field(default=None, pattern=r"^[A-Z]{3}$")
    week_start: Optional[Literal["0", "1"]] = None
    horizon_days: Optional[int] = Field(default=None, ge=7, le=365)
    upcoming_days: Optional[int] = Field(default=None, ge=1, le=90)
